# Antigravity (`agy`) integration notes

Findings from the #12 spike, run against `agy` 1.3.3 on macOS (2026-10-11). Each item is marked
**verified** (observed live) or **unverified** (documented only, or inferred).

## What cannot be done

- **Per-turn routing of the main session: not possible.** `agy` has no `ANTHROPIC_BASE_URL`
  equivalent, so there is no proxy point, and no hook output selects a model. `PreInvocation`
  may only return `injectSteps`; `PostInvocation` adds `terminationBehavior`. *(verified: docs
  plus hook payload keys observed live)*
- The main model is fixed per session through `--model` / `--effort` or the in-session picker.
  *(verified: `agy --help`)*

## What can be done

### Sub-agent model selection through `PreToolUse` (verified)

- Sub-agents are spawned with the tool `invoke_subagent`; matcher `invoke_subagent` hits it.
  *(verified)*
- Arguments: `{"Subagents": [{"TypeName", "Role", "Prompt", "Model", "Workspace"?}], ...}`, where
  `Model` is one of `inherit | flash_lite | flash | pro`. *(verified)*
- A hook may rewrite arguments with `overwrite`, a shallow top-level merge, so the whole
  `Subagents` array has to be returned. *(verified)*
- **`overwrite` without `decision` is treated as a denial** ("tool call denied by pre-tool hook").
  Return `{"decision": "allow", "overwrite": {...}}`. *(verified)*
- Effect: a sub-agent requested with `Model: "pro"` and rewritten to `flash_lite` ran on
  `gemini-3.5-flash-lite`, as the `modelName` field in its own hook payloads showed. *(verified)*
- Inside a sub-agent, a catch-all (`*`) hook that printed `{}` caused the sub-agent's own
  tool calls to be denied, while the same `{}` passed in the main agent. Keep the matcher
  limited to `invoke_subagent` and print `{}` only when nothing changes. *(verified)*
- The `Model` enum covers Gemini tiers only, so a hook cannot move a sub-agent to Claude or GPT.
  *(verified via the tool schema)*

### Hook payload (verified)

- `PreToolUse`: `toolCall.{name,args}`, `stepIdx`, `conversationId`, `modelName`,
  `transcriptPath`, `artifactDirectoryPath`, `workspacePaths`.
- `PreInvocation`: `invocationNum`, `initialNumSteps`, plus the common fields.
- `hooks.json` locations: workspace `.agents/hooks.json` *(verified)*; global
  `~/.gemini/antigravity-cli/hooks.json` is where this machine's existing hooks live
  *(observed, not re-tested)*. Each top-level key is a named hook that can be disabled with
  `"enabled": false`.

### Session start (`jev-agy` launcher, #13)

`agy -p/-i "<prompt>" --model <id> --effort <level>`: Jev can pick the model and effort from the
`agy models` catalogue for the first prompt. The model then stays fixed for that session.

## Consequences for the plan

| Issue | Decision |
|---|---|
| #13 `jev-agy` launcher | Feasible: Jev picks `--model` and `--effort` for `-p` and `-i` |
| #14 sub-agent hook | Feasible: `PreToolUse` on `invoke_subagent` with `decision: allow` and `overwrite` |
| #15 advisory fallback | Only for the main session: `PreInvocation` `ephemeralMessage` can suggest `/model`; it cannot switch |
