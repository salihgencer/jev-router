import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ConversationStates, familyKey, isCompaction, conversationKey, startProxy } from "../src/proxy.mjs";

const session = (id) => ({ user_id: JSON.stringify({ session_id: id }) });
const SUMMARY =
  "This session is being continued from a previous conversation that ran out of context. " +
  "The conversation is summarized below: ...";

test("the state store evicts the least recently used conversation, not the oldest (#6)", () => {
  const states = new ConversationStates(2);
  states.get("a").tier = "opus";
  states.get("b").tier = "haiku";
  states.get("a"); // touch a
  states.get("c"); // evicts b, the least recently used
  assert.equal(states.size, 2);
  assert.equal(states.get("a").tier, "opus");
  assert.equal(states.get("b").tier, null, "b was evicted and starts over");
});

test("a compacted conversation inherits the tier and model of the one it replaced", () => {
  const states = new ConversationStates();
  const before = states.get("k1", { family: "main" });
  Object.assign(before, { tier: "sonnet", model: "claude-sonnet-5", promptTokens: 150000, lastResponseAt: 1 });
  const after = states.get("k2", { family: "main", inherit: true });
  assert.equal(after.tier, "sonnet");
  assert.equal(after.model, "claude-sonnet-5");
  assert.equal(after.promptTokens, undefined, "compaction rebuilt the prompt, so its size starts over");
  assert.equal(after.lastResponseAt, undefined, "and so does the cache");
});

test("a new conversation that is not a compaction does not inherit", () => {
  const states = new ConversationStates();
  states.get("k1", { family: "main" }).tier = "haiku";
  assert.equal(states.get("k2", { family: "main" }).tier, null);
});

test("sub-agents and other sessions are separate families", () => {
  const main = { metadata: session("s1"), system: [{ type: "text", text: "You are Claude Code" }] };
  const sub = { metadata: session("s1"), system: [{ type: "text", text: "You are an Explore agent" }] };
  const other = { metadata: session("s2"), system: main.system };
  assert.notEqual(familyKey(main), familyKey(sub));
  assert.notEqual(familyKey(main), familyKey(other));
  assert.equal(familyKey(main), familyKey({ ...main, messages: [{ role: "user", content: "x" }] }));
});

test("recognises Claude Code's compaction summary", () => {
  assert.equal(isCompaction({ messages: [{ role: "user", content: SUMMARY }] }), true);
  assert.equal(
    isCompaction({ messages: [{ role: "user", content: [{ type: "text", text: SUMMARY }] }] }),
    true,
  );
  assert.equal(isCompaction({ messages: [{ role: "user", content: "fix the parser" }] }), false);
  assert.equal(isCompaction({}), false);
});

test("the proxy keeps the routed tier across /compact", async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push(JSON.parse(Buffer.concat(chunks)).model);
      res.setHeader("content-type", "application/json");
      res.end('{"id":"msg","usage":{"input_tokens":10}}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  // Jev picks sonnet on the first turn, then is unreachable.
  let calls = 0;
  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async () => (calls++ === 0 ? { choice: "claude-sonnet-5", confidence: 0.9, ms: 1 } : null),
  });
  t.after(close);

  const common = {
    model: "jev-router",
    tools: [{ name: "Bash" }],
    metadata: session(`compact-${process.pid}`),
    system: [{ type: "text", text: "You are Claude Code" }],
  };
  const send = (messages) =>
    fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...common, messages }),
    }).then((r) => r.text());

  const first = [{ role: "user", content: "implement the cache layer" }];
  await send(first);
  const compacted = [{ role: "user", content: `${SUMMARY}\n\ncontinue` }];
  assert.notEqual(conversationKey({ ...common, messages: first }), conversationKey({ ...common, messages: compacted }));
  await send(compacted);

  assert.deepEqual(seen, ["claude-sonnet-5", "claude-sonnet-5"], "no fall back to the opus default");
});
