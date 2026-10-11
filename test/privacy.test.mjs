import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { statSync, readdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrub, scrubPrompt, MAX_PROMPT_CHARS } from "../src/scrub.mjs";
import { dumpBody } from "../src/log.mjs";
import { startProxy } from "../src/proxy.mjs";

const noEnv = {};

test("redacts provider key shapes (#7)", () => {
  const samples = [
    "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
    "sk-proj-abcdefghijklmnopqrstuvwxyz0123",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
    "xoxb-1234567890-abcdefghij",
    "AIzaSyA1234567890abcdefghijklmnopqrstu",
    "AKIAIOSFODNN7EXAMPLE",
    "sk_live_abcdefghijklmnop1234",
    "hf_abcdefghijklmnopqrstuvwxyz",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  ];
  for (const secret of samples) {
    const out = scrub(`here is my key ${secret} please`, noEnv);
    assert.ok(!out.includes(secret), `leaked ${secret}`);
    assert.match(out, /\[REDACTED\]/);
  }
});

test("redacts PEM blocks, auth headers, assignments and URL credentials", () => {
  const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----";
  assert.equal(scrub(`key:\n${pem}\nend`, noEnv), "key:\n[REDACTED]\nend");
  assert.equal(scrub("Authorization: Bearer abcdef123456789", noEnv), "Authorization: [REDACTED]");
  assert.equal(scrub("API_KEY=supersecretvalue", noEnv), "API_KEY=[REDACTED]");
  assert.equal(scrub('"password": "hunter2hunter2"', noEnv), '"password": "[REDACTED]"');
  assert.equal(
    scrub("connect to postgres://admin:s3cretpass@db.example.com/app", noEnv),
    "connect to postgres://[REDACTED]@db.example.com/app",
  );
});

test("redacts the literal value of credential-like environment variables", () => {
  const env = { MY_SERVICE_TOKEN: "plain-looking-value-123", HOME: "/Users/me" };
  assert.equal(scrub("value is plain-looking-value-123 here, home /Users/me", env), "value is [REDACTED] here, home /Users/me");
});

test("leaves ordinary prompts alone", () => {
  const prompt = "refactor the token parser in src/lexer.ts and add tests for the key lookup";
  assert.equal(scrub(prompt, noEnv), prompt);
  assert.equal(scrub("", noEnv), "");
  assert.equal(scrub(undefined, noEnv), undefined);
});

test("scrubs before truncating, so a secret at the cut does not survive as a fragment", () => {
  const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
  const prompt = "a".repeat(MAX_PROMPT_CHARS - 10) + secret;
  const out = scrubPrompt(prompt, noEnv);
  assert.ok(out.length <= MAX_PROMPT_CHARS);
  assert.ok(!out.includes("sk-ant-api03"));
});

test("JEV_DUMP files are private to their owner", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-dump-"));
  try {
    const file = dumpBody({ messages: [] }, join(dir, "dump"));
    assert.ok(file);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(dumpBody({}, ""), null, "no prefix, no dump");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the proxy sends Jev only the scrubbed prompt", async (t) => {
  const upstream = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => res.end("{}"));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  const prompts = [];
  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async ({ prompt }) => {
      prompts.push(prompt);
      return null;
    },
  });
  t.after(close);

  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-router",
      tools: [{ name: "Bash" }],
      messages: [{ role: "user", content: `deploy with ghp_abcdefghijklmnopqrstuvwxyz0123456789 ${process.pid}` }],
    }),
  }).then((r) => r.text());

  assert.equal(prompts.length, 1);
  assert.ok(!prompts[0].includes("ghp_"), prompts[0]);
});
