import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { trivialPrompt, decide } from "../src/policy.mjs";
import { startProxy } from "../src/proxy.mjs";

const ALL = ["haiku", "sonnet", "opus"];

test("bare go-aheads are recognised in English and Turkish (#10)", () => {
  for (const p of ["ok", "OK!", "go ahead.", "lgtm", "Thanks!", "devam", "Devam et", "tamam", "onaylıyorum", "evet, devam"]) {
    assert.equal(trivialPrompt(p), "go-ahead", p);
  }
});

test("slash commands and empty prompts are skipped", () => {
  assert.equal(trivialPrompt("/compact"), "slash-command");
  assert.equal(trivialPrompt("<command-name>/review</command-name>"), "slash-command");
  assert.equal(trivialPrompt("   "), "empty");
  assert.equal(trivialPrompt(undefined), "empty");
});

test("very short replies are skipped, real tasks are not", () => {
  assert.equal(trivialPrompt("fix it pls"), "short");
  assert.equal(trivialPrompt("refactor the sync engine to use CRDTs"), null);
  assert.equal(trivialPrompt("ok but also add retries to the uploader"), null);
});

test("a skipped turn keeps the current tier", () => {
  const out = decide({ prompt: "devam", jev: null, current: "opus", available: ALL, skip: "go-ahead" });
  assert.equal(out.tier, "opus");
  assert.match(out.reason, /^skip-go-ahead/);
  assert.equal(out.changed, false);
});

test("an explicit tier instruction still wins over a skip", () => {
  const out = decide({ prompt: "ok use haiku", jev: null, current: "opus", available: ALL, skip: "short" });
  assert.equal(out.tier, "haiku");
  assert.equal(out.reason, "override");
});

test("the proxy does not call Jev for a go-ahead", async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push(JSON.parse(Buffer.concat(chunks)).model);
      res.setHeader("content-type", "application/json");
      res.end('{"usage":{"input_tokens":10}}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  let calls = 0;
  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async () => {
      calls++;
      return { choice: "claude-haiku-4-5", confidence: 0.95, ms: 1 };
    },
  });
  t.after(close);

  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-router",
      tools: [{ name: "Bash" }],
      messages: [{ role: "user", content: "devam" }],
    }),
  });
  await res.text();
  assert.equal(calls, 0, "Jev is not asked");
  assert.equal(seen.length, 1);
  assert.doesNotMatch(seen[0], /haiku/, "go-ahead does not drop to the fast tier");
});
