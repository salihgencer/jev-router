import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  TIERS,
  tierOf,
  idOf,
  availableTiers,
  tierSpec,
  isAuto,
  shouldUseExactModel,
  THRESHOLDS,
} from "./config.mjs";
import { askJev } from "./router.mjs";
import { decide } from "./policy.mjs";
import { log } from "./log.mjs";
import { writeDecision, writeStatus } from "./status.mjs";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const debug = (line) => process.env.JEV_DEBUG && log(line);

/**
 * Claude Code converts draft-04 relics in MCP tool schemas before sending them first-party,
 * but skips that when ANTHROPIC_BASE_URL is set, so the API rejects the request. In draft
 * 2020-12 `exclusiveMinimum`/`exclusiveMaximum` are numbers, not booleans.
 */
export function sanitizeSchema(node) {
  if (Array.isArray(node)) return node.forEach(sanitizeSchema);
  if (!node || typeof node !== "object") return;
  for (const [key, bound] of [
    ["exclusiveMinimum", "minimum"],
    ["exclusiveMaximum", "maximum"],
  ]) {
    if (typeof node[key] === "boolean") {
      if (node[key] && typeof node[bound] === "number") {
        node[key] = node[bound];
        delete node[bound];
      } else {
        delete node[key];
      }
    }
  }
  for (const v of Object.values(node)) sanitizeSchema(v);
}

/**
 * The text of a genuinely new user turn, or null.
 *
 * A turn can continue for many requests while Claude works through tool calls, and those
 * continuations end in a `tool_result` rather than typed text. Routing them would re-ask
 * Jev on every tool call and let the model flip mid-task, so only the opening request of a
 * turn counts. Claude Code also injects `<system-reminder>` blocks into the user message,
 * which are noise to a router and measurably blunt Jev's confidence, so they are removed.
 */
export function newTurnPrompt(body) {
  if (!Array.isArray(body?.tools) || body.tools.length === 0) return null; // auxiliary call
  const last = body?.messages?.[body.messages.length - 1];
  if (!last || last.role !== "user") return null;
  let text;
  if (typeof last.content === "string") {
    text = last.content;
  } else if (Array.isArray(last.content)) {
    if (last.content.some((b) => b.type === "tool_result")) return null;
    text = last.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  } else {
    return null;
  }
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim() || null;
}

/**
 * Points a request at a tier, removing request fields that tier cannot accept. Claude Code
 * composes the body for whatever model it thinks it is talking to, so downgrading to Haiku
 * while leaving `thinking: {type:"adaptive"}` in place is a hard 400.
 */
export function applyTier(body, tierName, model = idOf(tierName)) {
  const tier = tierSpec(tierName);
  if (!tier) return body;
  body.model = model;
  if (!tier.thinking) {
    delete body.thinking;
    // A context-management strategy that prunes thinking blocks is itself rejected once
    // thinking is gone, so it has to go with it.
    const edits = body.context_management?.edits;
    if (Array.isArray(edits)) {
      body.context_management.edits = edits.filter((e) => !/thinking/i.test(e?.type ?? ""));
      if (body.context_management.edits.length === 0) delete body.context_management;
    }
  }
  if (!tier.effort && body.output_config) {
    delete body.output_config.effort;
    if (Object.keys(body.output_config).length === 0) delete body.output_config;
  }
  return body;
}

/** Exact Claude models reported by the account, newest first; static ids are the cold-start fallback. */
export function claudeModels(catalog = []) {
  const models = catalog
    .filter((model) => tierOf(model?.id))
    .map((model) => ({
      id: model.id,
      tier: tierOf(model.id),
      description: [
        model.display_name,
        model.created_at && `released ${model.created_at.slice(0, 10)}`,
        model.max_input_tokens && `${model.max_input_tokens} input tokens`,
      ].filter(Boolean).join("; "),
    }));
  return models.length
    ? models
    : TIERS.map((tier) => ({ id: tier.id, tier: tier.name, description: tier.id }));
}

const modelForTier = (models, tier) => models.find((model) => model.tier === tier)?.id ?? idOf(tier);

/**
 * Identifies the conversation a request belongs to. Claude Code runs sub-agents through the
 * same endpoint, so a single pinned model would let a sub-agent's choice leak into the main
 * conversation.
 *
 * Only stable fields may be used. Claude Code moves its `cache_control` breakpoint between
 * requests and rewrites message metadata, so the key is built from the session id plus the
 * text of the first message, which is fixed once a conversation starts and differs between
 * the main agent and each sub-agent.
 */
/**
 * Session id Claude Code embeds in request metadata, or "" when it isn't present.
 * `metadata.user_id` is a JSON string, not a plain id.
 */
export function sessionOf(body) {
  try {
    return JSON.parse(body?.metadata?.user_id ?? "{}").session_id ?? "";
  } catch {
    return "";
  }
}

export function conversationKey(body) {
  const session = sessionOf(body);
  const content = body?.messages?.[0]?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("")
        : "";
  return createHash("sha1").update(`${session}|${text}`).digest("hex").slice(0, 12);
}

const blockText = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((b) => b?.type === "text").map((b) => b.text).join("")
      : "";

/**
 * Identifies which agent a conversation belongs to: the session plus the system prompt. The
 * main agent keeps its system prompt across /compact, while each sub-agent type has its own,
 * so this links a compacted conversation back to the one it replaced.
 */
export function familyKey(body) {
  return createHash("sha1").update(`${sessionOf(body)}|${blockText(body?.system)}`).digest("hex").slice(0, 12);
}

/**
 * Whether a conversation opens with Claude Code's compaction summary. /compact replaces the
 * history, so the first message (and with it the conversation key) changes. The wording is
 * Claude Code's and is not a public contract; /clear produces no summary and starts afresh.
 */
export const isCompaction = (body) =>
  /session is being continued from a previous conversation/i.test(blockText(body?.messages?.[0]?.content));

/**
 * Per-conversation routing state, least-recently-used first out. A compacted conversation
 * inherits the tier and exact model of the conversation it replaced; its prompt size and
 * cache age start over, because compaction rebuilt the prompt.
 */
export class ConversationStates {
  constructor(limit = 100) {
    this.limit = limit;
    this.states = new Map();
    this.latest = new Map(); // family key -> conversation key last used in that family
  }

  get(key, { family, inherit = false } = {}) {
    let state = this.states.get(key);
    if (state) {
      this.states.delete(key); // re-insert to mark as most recently used
    } else {
      state = { tier: null };
      const previous = inherit && family ? this.states.get(this.latest.get(family)) : null;
      if (previous?.tier) Object.assign(state, { tier: previous.tier, model: previous.model, compacted: true });
      while (this.states.size >= this.limit) this.states.delete(this.states.keys().next().value);
    }
    this.states.set(key, state);
    if (family) {
      this.latest.delete(family);
      this.latest.set(family, key);
      while (this.latest.size > this.limit) this.latest.delete(this.latest.keys().next().value);
    }
    return state;
  }

  get size() {
    return this.states.size;
  }
}

/**
 * Records the tier Claude Code is asking for and reports whether the user has taken manual
 * control. The first tier seen in a conversation is the baseline; any later change means the
 * user picked a model with /model, and an explicit choice must beat the router. Compared by
 * tier rather than exact model id, because Claude Code varies the id within a tier.
 */
export function observeModel(state, current) {
  state.baseline ??= current;
  if (current !== state.baseline) state.manual = true;
  return state.manual;
}

/**
 * Approximate prompt size of a request. Switching models rebuilds the cache for everything
 * in front of the new turn, which includes Claude Code's system prompt and tool definitions
 * (often 20k+ tokens on their own), not just the messages.
 */
export function estimateContextTokens(body) {
  const { system, tools, messages } = body ?? {};
  return Math.round(JSON.stringify([system ?? "", tools ?? [], messages ?? []]).length / 4);
}

/**
 * Prompt tokens the API reports for a response: uncached input plus cache reads and writes.
 * Reads the `message_start` event of a stream, or the `usage` of a plain JSON response.
 * Returns null when the text holds neither.
 */
export function promptTokensFrom(text) {
  const usageOf = (obj) => obj?.message?.usage ?? obj?.usage;
  const total = (u) =>
    u && typeof u.input_tokens === "number"
      ? u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      : null;
  const start = /event:\s*message_start\s*\ndata:\s*(\{.*\})/.exec(text);
  try {
    if (start) return total(usageOf(JSON.parse(start[1])));
    if (/^\s*\{/.test(text)) return total(usageOf(JSON.parse(text)));
  } catch {
    // Incomplete or malformed; the caller keeps its estimate.
  }
  return null;
}

/**
 * Context size used by the policy: the larger of the local estimate and what the API
 * measured for this conversation's previous request, so a downgrade is never priced on an
 * undercount.
 */
export const contextTokensFor = (body, state) =>
  Math.max(estimateContextTokens(body), state?.promptTokens ?? 0);

/** How much of a response the proxy buffers while looking for its usage. */
const USAGE_SNIFF_BYTES = 64 * 1024;

/** Prompt-cache lifetime the request asks for: one hour if any breakpoint says so. */
export const cacheTtlFor = (body) =>
  /"ttl"\s*:\s*"1h"/.test(JSON.stringify(body ?? {})) ? THRESHOLDS.cacheTtlLongMs : THRESHOLDS.cacheTtlMs;

/**
 * Whether this conversation's prompt cache is still alive. A conversation with no answered
 * request yet has nothing cached, so it counts as cold and switching is free.
 */
export const cacheWarmFor = (state, ttlMs, now = Date.now()) =>
  Boolean(state?.lastResponseAt) && now - state.lastResponseAt < ttlMs;

/** Largest context window the account's catalog reports for each tier. */
export function windowsFrom(catalog = []) {
  const windows = {};
  for (const model of catalog) {
    const tier = tierOf(model?.id);
    if (tier && typeof model.max_input_tokens === "number") {
      windows[tier] = Math.max(windows[tier] ?? 0, model.max_input_tokens);
    }
  }
  return windows;
}


export async function startProxy({ upstreamURL = ANTHROPIC_BASE_URL, route = askJev } = {}) {
  // Tier routed for each conversation's turn in flight, reused by its follow-up requests and
  // by the cache-rebuild guard, which needs to know what the prompt cache was built on.
  const convos = new ConversationStates();
  const catalog = new Map();
  const stateFor = (body) =>
    convos.get(conversationKey(body), { family: familyKey(body), inherit: isCompaction(body) });

  const server = http.createServer((req, res) => {
    // Claude Code probes the base URL before its first request.
    if (req.method === "HEAD") return res.writeHead(200).end();

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let out = Buffer.concat(chunks);
      // Conversation state of a routed request, so its response usage can be recorded.
      let routedState = null;

      if (/^\/v1\/messages/.test(req.url ?? "")) {
        try {
          const body = JSON.parse(out.toString());
          // Claude Code's request shape is undocumented and moves; JEV_DUMP captures it.
          if (process.env.JEV_DUMP) {
            writeFileSync(`${process.env.JEV_DUMP}.${Date.now()}.json`, JSON.stringify(body, null, 2));
          }
          body.tools?.forEach((t) => sanitizeSchema(t.input_schema));

          // Anything that is not the sentinel is a model the user chose, and an explicit
          // choice beats the router. That also covers Claude Code's own cheap Haiku calls
          // for titles and summaries, which must never be pinned up to the session's tier.
          if (!isAuto(body.model)) {
            debug(`passthrough, user selected ${body.model}`);
            // Only a real agent turn reflects the user's choice. Claude Code's own auxiliary
            // calls carry no tools and must not flip the status line to manual mid-session.
            if (Array.isArray(body.tools)) {
              writeStatus(sessionOf(body), { manual: true, at: Date.now() });
            }
          } else {
            const key = conversationKey(body);
            const state = stateFor(body);
            routedState = state;
            // What the prompt cache was built on, which is what a downgrade would discard.
            const current = state.tier ?? "opus";
            const prompt = newTurnPrompt(body);
            const explaining = prompt?.includes("<jev-explain>");
            let fresh = null;
            if (prompt && !explaining) {
              const models = claudeModels([...catalog.values()]).filter((model) =>
                availableTiers().includes(model.tier),
              );
              const available = [...new Set(models.map((model) => model.tier))];
              const currentModel = state.model ?? modelForTier(models, current);
              const contextTokens = contextTokensFor(body, state);
              const jev = await route({ prompt, current: currentModel, contextTokens, models });
              const chosen = models.find((model) => model.id === jev?.choice);
              const tierAnswer = jev && { ...jev, choice: chosen?.tier };
              const { tier, reason } = decide({
                prompt,
                jev: tierAnswer,
                current,
                available,
                contextTokens,
                cacheWarm: cacheWarmFor(state, cacheTtlFor(body)),
                windows: windowsFrom([...catalog.values()]),
              });
              const model =
                shouldUseExactModel(reason, chosen?.tier, tier)
                  ? chosen.id
                  : tier === current
                    ? currentModel
                    : modelForTier(models, tier);
              state.tier = tier;
              state.model = model;
              fresh = {
                prompt,
                model,
                confidence: jev?.confidence ?? null,
                jevModel: jev?.jevModel ?? null,
                metrics: jev?.metrics ?? null,
                reason,
                jev: jev ? { request: jev.request, response: jev.response } : null,
              };
              debug(
                `${key} ${jev ? `${jev.ms}ms p=${jev.confidence.toFixed(2)}` : "no-jev"} ` +
                  `${current} -> ${tier} (${reason}) ctx~${contextTokens} | ${prompt.slice(0, 60)}`,
              );
            }
            // The sentinel is not a real model, so every routed request must be rewritten,
            // including follow-ups that reuse the tier chosen for the turn.
            const tier = state.tier ?? current;
            const model = state.model ?? idOf(tier);
            debug(`${key} rewrite ${body.model} -> ${model}`);
            applyTier(body, tier, model);
            // Publish what went out. Claude Code's UI shows the row you picked, not the tier
            // it resolved to, so the status line is the only place this is visible.
            // `claude -p` omits metadata on the first request of a session, so there is no
            // session id to file the decision under and it would be dropped. The conversation
            // key is stable for the same conversation and is already what `debug` prints, so
            // it is the identifier a user can pass to `jev-explain` for a print-mode run.
            if (fresh && !explaining) {
              writeDecision(sessionOf(body) || key, { tier, ...fresh, at: Date.now() });
            }
          }
          out = Buffer.from(JSON.stringify(body));
        } catch (err) {
          debug(`passthrough, could not process body: ${err.message}`);
        }
      }

      const target = new URL(upstreamURL);
      const transport = target.protocol === "http:" ? http : https;
      const headers = { ...req.headers, host: target.host };
      delete headers["content-length"];
      if (req.method === "GET" && /^\/v1\/models(?:\?|$)/.test(req.url ?? "")) {
        delete headers["accept-encoding"];
      }
      // Under JEV_DEBUG, ask for an uncompressed stream so the model the API reports can be
      // read back out of it. Routed requests are also asked uncompressed so their usage can
      // be read; Messages API streams are small SSE frames, so the bandwidth cost is minor.
      if (process.env.JEV_DEBUG || routedState) delete headers["accept-encoding"];
      const upstream = transport.request(
        {
          hostname: target.hostname,
          port: target.port || undefined,
          path: `${target.pathname.replace(/\/$/, "")}${req.url}`,
          method: req.method,
          headers,
        },
        (up) => {
          const isModels = req.method === "GET" && /^\/v1\/models(?:\?|$)/.test(req.url ?? "");
          if (isModels) {
            const chunks = [];
            up.on("data", (chunk) => chunks.push(chunk));
            up.on("end", () => {
              const data = Buffer.concat(chunks);
              try {
                for (const model of JSON.parse(data.toString()).data ?? []) {
                  if (tierOf(model?.id)) catalog.set(model.id, model);
                }
              } catch (err) {
                debug(`could not read Claude model catalog: ${err.message}`);
              }
              const headers = { ...up.headers };
              delete headers["content-length"];
              res.writeHead(up.statusCode, headers);
              res.end(data);
            });
            return;
          }
          res.writeHead(up.statusCode, up.headers);
          // Record the prompt size the API measured, for the next turn's switch pricing.
          // Only the head of the response is inspected, and the stream is never delayed.
          if (routedState && up.statusCode >= 200 && up.statusCode < 300 && !up.headers["content-encoding"]) {
            const state = routedState;
            let head = "";
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              const tokens = promptTokensFrom(head);
              if (tokens != null) state.promptTokens = tokens;
              state.lastResponseAt = Date.now();
            };
            up.on("data", (c) => {
              if (done) return;
              head += c.toString("utf8");
              if (promptTokensFrom(head) != null || head.length > USAGE_SNIFF_BYTES) finish();
            });
            up.on("end", finish);
          }
          // Report the model the API itself says it used, so the routing can be confirmed
          // from the wire rather than trusted from our own decision log. Claude Code's UI
          // always shows the model it asked for, never the one we rewrote to.
          if (process.env.JEV_DEBUG) {
            let seen = false;
            up.on("data", (c) => {
              if (seen) return;
              const m = /"model"\s*:\s*"([^"]+)"/.exec(c.toString("utf8"));
              if (!m) return;
              seen = true;
              debug(`${up.statusCode} served by ${m[1]}`);
            });
          }
          up.pipe(res);
        },
      );
      upstream.on("error", (e) => {
        debug(`upstream error: ${e.message}`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { message: e.message } }));
      });
      if (out.length) upstream.write(out);
      upstream.end();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => server.close() };
}
