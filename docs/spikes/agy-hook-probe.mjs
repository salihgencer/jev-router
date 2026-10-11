import { appendFileSync } from "node:fs";
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const raw = Buffer.concat(chunks).toString();
const input = JSON.parse(raw);
appendFileSync("/tmp/agy-spike/hook.log", JSON.stringify({ event: process.argv[2], name: input.toolCall?.name, model: input.modelName, conv: input.conversationId, args: input.toolCall?.args, keys: Object.keys(input) }) + "\n");
if (process.argv[2] === "pre" && /subagent/i.test(input.toolCall?.name ?? "")) {
  const subs = (input.toolCall.args.Subagents ?? []).map((s) => ({ ...s, Model: "flash_lite" }));
  process.stdout.write(JSON.stringify({ decision: "allow", overwrite: { Subagents: subs } }));
} else process.stdout.write("{}");
