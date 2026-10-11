import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  estimateContextTokens,
  promptTokensFrom,
  contextTokensFor,
  startProxy,
} from "../src/proxy.mjs";
import { codexContextTokens } from "../src/codex-proxy.mjs";

const bigSystem = "x".repeat(40000); // ~10k tokens of system prompt
const bigTools = [{ name: "Bash", description: "y".repeat(40000) }]; // ~10k tokens of tools

test("the estimate counts system prompt and tool definitions, not just messages (#4)", () => {
  const messages = [{ role: "user", content: "hi" }];
  const onlyMessages = Math.round(JSON.stringify(messages).length / 4);
  const full = estimateContextTokens({ system: bigSystem, tools: bigTools, messages });
  assert.ok(full > onlyMessages + 19000, `expected system+tools in the estimate, got ${full}`);
  assert.equal(estimateContextTokens(undefined) >= 0, true);
});

test("Codex estimate counts instructions and tools", () => {
  const input = [{ role: "user", content: "hi" }];
  assert.ok(codexContextTokens({ instructions: bigSystem, tools: bigTools, input }) > 19000);
});

test("reads prompt tokens from a streamed message_start", () => {
  const sse =
    'event: message_start\ndata: {"type":"message_start","message":{"usage":' +
    '{"input_tokens":12,"cache_creation_input_tokens":3000,"cache_read_input_tokens":40000}}}\n\n';
  assert.equal(promptTokensFrom(sse), 43012);
});

test("reads prompt tokens from a plain JSON response", () => {
  assert.equal(promptTokensFrom('{"usage":{"input_tokens":500,"cache_read_input_tokens":100}}'), 600);
});

test("returns null for incomplete or usage-free text", () => {
  assert.equal(promptTokensFrom('event: message_start\ndata: {"type":"mess'), null);
  assert.equal(promptTokensFrom('{"id":"msg_1"}'), null);
  assert.equal(promptTokensFrom(""), null);
});

test("measured usage wins over a smaller estimate, never the other way", () => {
  const body = { messages: [{ role: "user", content: "hi" }] };
  assert.equal(contextTokensFor(body, { promptTokens: 90000 }), 90000);
  assert.equal(contextTokensFor(body, {}), estimateContextTokens(body));
  assert.equal(contextTokensFor({ system: bigSystem }, { promptTokens: 5 }), estimateContextTokens({ system: bigSystem }));
});

test("the proxy feeds the API's measured prompt size into the next turn's decision", async (t) => {
  const encodings = [];
  const upstream = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      encodings.push(req.headers["accept-encoding"]);
      res.setHeader("content-type", "text/event-stream");
      res.write(
        'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-5",' +
          '"usage":{"input_tokens":10,"cache_read_input_tokens":90000,"cache_creation_input_tokens":0}}}\n\n',
      );
      res.end("event: message_stop\ndata: {}\n\n");
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  const contexts = [];
  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async ({ contextTokens }) => {
      contexts.push(contextTokens);
      return { choice: "claude-opus-5", confidence: 0.9, ms: 1 };
    },
  });
  t.after(close);

  const send = (messages) =>
    fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "accept-encoding": "gzip" },
      body: JSON.stringify({ model: "jev-router", tools: [{ name: "Bash" }], messages }),
    }).then((r) => r.text());

  const first = [{ role: "user", content: `first turn ${process.pid}` }];
  await send(first);
  await send([...first, { role: "assistant", content: "done" }, { role: "user", content: "second turn" }]);

  assert.equal(contexts.length, 2);
  assert.ok(contexts[0] < 1000, "the first turn has only the estimate");
  assert.equal(contexts[1], 90010, "the second turn uses what the API measured");
  assert.deepEqual(encodings, [undefined, undefined], "routed responses are requested uncompressed");
});
