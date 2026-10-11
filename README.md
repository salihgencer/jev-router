# jev-router

Automatic per-turn model routing for Claude Code and OpenAI Codex. Jev sends simple work to
the fast tier and difficult work to the strong tier, while preserving each CLI's native
interface, tools, sessions, permissions, and authentication.

| Command | Interface | Authentication | Routing decision |
| --- | --- | --- | --- |
| `jev-claude` | Claude Code | Existing `claude login` | Status line |
| `jev-codex` | OpenAI Codex | Existing `codex login` | Commentary line |

Both commands launch the real upstream CLI. Jev only chooses the model for a fresh user turn.

## Quick start

Requires Node.js 22+ and at least one supported CLI:
[Claude Code](https://code.claude.com/docs/en/setup) or
[OpenAI Codex](https://developers.openai.com/codex/cli).

### 1. npm package

```bash
npm install -g jev-router
echo "JEV_API_KEY=..." > ~/.jev-router.env
```

### 2. Local repository

```bash
git clone https://github.com/gargpratyush/jev-router.git
cd jev-router
npm install
npm link
echo "JEV_API_KEY=..." > ~/.jev-router.env
```

On Windows PowerShell:

```powershell
Set-Content "$HOME\.jev-router.env" "JEV_API_KEY=..."
```

Get a key from [TypeSafe](https://docs.typesafe.ai). Then launch either interface from any
repository:

```bash
jev-claude
jev-codex
```

No Anthropic or OpenAI API key is required when the corresponding CLI is already logged in
with a subscription. Every CLI argument is forwarded:

```bash
jev-claude --resume
jev-claude -p "fix the failing test"
jev-codex resume --last
jev-codex exec "fix the failing test"
```

For a local checkout, `npm link` installs both commands. Without it, run
`node bin/jev-claude.mjs` or `node bin/jev-codex.mjs`.

## Claude Code interface

![Jev Router in the Claude Code model picker](docs/model-picker.png)

`jev-claude` launches Claude Code with **Jev Router** selected in `/model`. Selecting another
model pauses routing; selecting **Jev Router** resumes it.

The injected status line shows the model used for the last turn:

```text
⚡ haiku p=0.98 · my-project · 8% context
⏸ manual Opus 4.6 · my-project · 21% context
```

Claude Code otherwise remains unchanged, including its keybindings, tools, permission prompts,
`/compact`, `/resume`, and session handling. An existing custom `statusLine` is preserved;
set `JEV_NO_STATUSLINE=1` to disable Jev's status line.

The explanation skill is bundled with the npm package and loaded automatically: run
`/jev-explain` in `jev-claude`, or `$jev-explain` in `jev-codex`, to see the factors behind
the last routing decision:

```text
┌─────────────────────────────────┐
│ Jev Router                      │
│                                 │
│ Jev request                     │
│ Prompt: explain the router      │
│ Current tier: HAIKU             │
│ Context tokens: 6200            │
│                                 │
│ Jev response                    │
│ Task complexity     0.82        │
│ Reasoning required  0.91        │
│ Tool complexity     0.64        │
│ Context size        0.31        │
│                                 │
│ Recommended tier: SONNET        │
│ Selected model: SONNET          │
│                                 │
│ Confidence: 94%                 │
│ Decision: Jev recommendation    │
└─────────────────────────────────┘
```

The report is rendered locally from the exact prompt, System One request, and System One
response saved when routing occurred. Recent decisions are retained per CLI session; invoking
the explanation skill does not ask Jev to score the prompt again.

### Explanation data location

Both `jev-claude` and `jev-codex` keep up to 20 recent routing exchanges in one JSON file per
CLI session under Node.js's operating-system temporary directory:

| Platform | Default location |
| --- | --- |
| Windows | `%TEMP%\jev-claude\<session-id>.json` |
| macOS | `$TMPDIR/jev-claude/<session-id>.json` (normally under `/var/folders/.../T`) |
| Ubuntu/Linux | `${TMPDIR:-/tmp}/jev-claude/<session-id>.json` |

Print the exact directory selected on the current machine with:

```bash
node -e "console.log(require('node:path').join(require('node:os').tmpdir(), 'jev-claude'))"
```

Claude filenames use Claude Code's session UUID. Codex filenames use
`codex-<jev-codex-process-id>.json`. These temporary files contain prompt text and Jev's exact
request and response, so they are readable only by you (the directory is created with mode 700 and each
file with 600). Files not updated for 7 days are deleted automatically, and the operating system
may also remove them during normal temporary-file cleanup.

> Choosing a model with `Enter` can save it as Claude Code's default. `jev-claude` restores
> the previous default on exit so `jev-router` cannot break plain `claude`.

### Sub-agent routing

A sub-agent starts with an empty context, so picking its model costs no prompt-cache rebuild.
`jev-subagent-hook` is a `PreToolUse` hook on Claude Code's `Agent` tool that asks Jev for each
sub-agent's brief and sets the Agent call's `model` (`haiku`, `sonnet` or `opus`). It works in a
plain `claude` session too, where the main model stays whatever you chose.

```sh
jev-subagent-hook install     # adds the hook to ~/.claude/settings.json, backing it up first
jev-subagent-hook uninstall
```

It leaves a call alone when Claude already passed a model, when the agent's front matter pins
one, when the agent cannot be found, inside `jev-claude` (whose proxy already routes inheriting
sub-agents), and on any Jev failure or low-confidence answer. Other hooks are kept as they are.

## OpenAI Codex interface

![Jev Router in the OpenAI Codex model picker](docs/codex-model-picker.png)

`jev-codex` launches Codex with a temporary **Jev Router** provider and selects `jev-router`.
The native `/model` picker still contains the models available to the account. Selecting a
concrete model pauses routing; selecting **Jev Router** resumes it.

Each fresh decision appears as Codex commentary:

```text
[Jev] routed this turn to gpt-5.6-sol (jev, confidence 0.91).
```

`jev-codex` installs or refreshes the packaged `$jev-explain` skill when it starts, so it is
available from any repository without separate setup.

Codex's footer shows `jev-router` because it displays the selected picker entry,
not the model chosen behind that provider. If Jev is unavailable, the commentary names the
fallback model and explains how to set `JEV_API_KEY`.

## How it works

Each command starts a loopback proxy, launches the real CLI, and forwards the CLI's existing
authorization headers without reading, storing, or modifying them.

```text
you -> Claude Code -> jev-claude proxy -> Anthropic
                         |
                         +-> Jev: choose a tier

you -> OpenAI Codex -> jev-codex proxy -> OpenAI
                         |
                         +-> Jev: choose a tier
```

Claude Code uses `ANTHROPIC_BASE_URL`; Codex uses a temporary custom provider with
`requires_openai_auth=true`. Claude and Codex both use `jev-router` as the
routing sentinel.
Any concrete model selected by the user passes through unchanged.

## Routing policy

One Jev call per fresh user turn selects a shared abstract tier:

| Tier | Claude Code default | Codex default |
| --- | --- | --- |
| Fast | Haiku | `gpt-5.6-luna` |
| Balanced | Sonnet | `gpt-5.6-terra` |
| Strong | Opus | `gpt-5.6-sol` |
| Long | Fable | `gpt-6-astra` |

`src/policy.mjs` then applies these rules:

- explicit requests such as `use opus`, `use luna`, `use strong` or `opus kullan` win, but only
  as a clause-leading instruction: quoted or pasted text, negations (`don't use haiku`),
  conditionals (`if it runs long, switch to opus`) and phrases such as `use strong typing` or
  `use fast-glob` are ignored;
- bare go-aheads (`ok`, `continue`, `devam`, `tamam`), slash commands and replies under 12
  characters skip the Jev call and keep the current model, so a running task never drops to the
  fast tier on a one-word reply;
- failure, timeout, or an unrecognised Jev answer keeps the current model; after a failure Jev is
  paused for 30 seconds so an outage costs one deadline, not one per prompt;
- low confidence never downgrades and caps upgrades at the balanced tier;
- a downgrade goes ahead only if it earns back the prompt-cache rewrite (plus the likely
  rewrite on the way back up) within the next few requests; a cache idle past its TTL
  (5 minutes, or 1 hour when Claude Code asks for it) is cold, so switching is then free;
- no turn goes to a tier whose context window the conversation does not fit, even one the
  user named;
- unavailable tiers step upward rather than silently choosing a weaker model;
- subscription usage read from response headers (`anthropic-ratelimit-unified-*-utilization`,
  `x-codex-*-used-percent`) caps Jev's pick: above 80% of a window the strongest tier is the
  balanced one, above 95% only the fast tier is used, and a tier whose own window (such as a
  weekly Opus limit) is above 90% steps down. An explicit `use opus` is never capped. The
  status line shows the fullest window once it passes 50%;
- the long tier is disabled unless `JEV_ALLOW_FABLE=1`.

Tool-loop continuations keep the tier chosen at the start of the turn. Main conversations and
sub-agents are pinned separately. Routing is fail-open: Jev failure never blocks the CLI.

## Configuration

| Variable | Interface | Effect |
| --- | --- | --- |
| `JEV_API_KEY` | Both | Enables routing. `TYPESAFE_API_KEY` also works. |
| `JEV_MODEL` | Both | Jev model version; pinned to `jev-1.13.0` because the thresholds were tuned on it. |
| `JEV_ALLOW_FABLE` | Both | Enables the opt-in long tier. |
| `JEV_DEBUG` | Both | Logs decisions and rewrites to `~/.jev-claude.log` in interactive sessions. |
| `JEV_DUMP` | Both | Dumps request bodies for debugging wire-format changes. |
| `JEV_NO_STATUSLINE` | Claude | Disables the injected Claude status line. |
| `JEV_CODEX_FAST_MODEL` | Codex | Fast model; defaults to `gpt-5.6-luna`. |
| `JEV_CODEX_BALANCED_MODEL` | Codex | Balanced model; defaults to `gpt-5.6-terra`. |
| `JEV_CODEX_STRONG_MODEL` | Codex | Strong model; defaults to `gpt-5.6-sol`. |
| `JEV_CODEX_LONG_MODEL` | Codex | Long model; defaults to `gpt-6-astra`. |

Existing environment variables have highest precedence, followed by `.env` in the launch
directory, `~/.jev-router.env`, and the legacy `~/.jev-claude.env`.

Tier definitions, Jev's question, confidence thresholds, and timeouts live in `src/config.mjs`.
Both launchers send Jev the exact models in the signed-in account's native catalog, so model
versions such as `claude-opus-4-8` and `claude-opus-5` remain separate choices. Static model
ids are used only until the CLI fetches its catalog.

## Compatibility notes

- Claude Code needs schema normalisation for older MCP JSON Schema fields when a custom base
  URL is active.
- Claude request fields unsupported by a routed tier, such as adaptive thinking on Haiku,
  are removed before forwarding.
- Codex's current request format stores tool definitions inside its Responses API input.
- Codex's ChatGPT backend may stream SSE without a `Content-Type` header; the proxy detects
  the event stream from its first frame.
- Codex workspace-specific enterprise origins are internal to its built-in provider and
  cannot be reproduced by a custom provider.

## Development

```bash
npm install
echo "JEV_API_KEY=..." > .env

npm test
node test/live-routing.mjs
node bin/jev-claude.mjs -p "what is 2+2?"
node bin/jev-codex.mjs exec "what is 2+2?"
```

The test suite covers shared policy, both request formats, model rewriting, capability
handling, settings restoration, Codex authentication forwarding, native model-picker
injection, and decision display.

## Limitations

- The user's prompt text is sent to TypeSafe for the routing decision. Nothing else is. Secrets
  (key and token shapes, PEM blocks, `KEY=` assignments, URL credentials and the values of
  credential-like environment variables) are redacted first and the prompt is capped at 6000
  characters; the same redacted form is what decision files store. Redaction lowers the risk
  of leaking a pasted secret but is not a guarantee. Debug logs and `JEV_DUMP` files are
  owner-only (mode 600).
- Jev adds latency only to the first request of a turn; tool-loop continuations add none.
- Claude Code and Codex request formats are not public contracts. Use `JEV_DUMP` to diagnose
  upstream changes.
- Developed on Windows against Claude Code v2.1.101 and OpenAI Codex v0.154.0; this fork is
  developed on macOS. CI runs the unit tests on Ubuntu, macOS and Windows with Node.js 22 and 24 (the supported LTS lines).

## Contributing

Issues and pull requests are welcome. Use [Issues](https://github.com/gargpratyush/jev-router/issues)
to report bugs, request improvements, or ask questions. Include the relevant Claude Code or
Codex version, reproduction steps, expected behavior, and useful logs with secrets removed.

For a pull request:

1. Open an issue first - all PRs by contributors should be linked with an approved issue. Explain the problem and validation in the issue description.
2. Fork the repository and create a focused branch from `master`.
3. Make the smallest change that solves the problem.
4. Run `npm test` and include tests for non-trivial behavior changes.
5. Claude/Copilot/Codex shall not be the contributors. 

Please do not commit API keys or other secrets. All contributions require review, and only the
repository owner can merge pull requests.

## License

MIT
