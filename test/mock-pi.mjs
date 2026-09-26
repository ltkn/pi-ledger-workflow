#!/usr/bin/env node
// Stand-in for the fresh `pi --mode json -p` reviewer. MOCK_REVIEW picks the verdict.
import * as fs from "node:fs";
const argv = process.argv.slice(2);
const sys = fs.readFileSync(argv[argv.indexOf("--append-system-prompt") + 1], "utf8");
const brief = fs.readFileSync(argv.find((a) => a.startsWith("@")).slice(1), "utf8");
if (process.env.MOCK_BRIEF_OUT) fs.writeFileSync(process.env.MOCK_BRIEF_OUT, brief);
const verdict = process.env.MOCK_REVIEW ?? "pass";
const text = sys.includes("REVIEWER")
  ? `Verdict: ${verdict}\n\n1. src/order.ts:12 — consider a guard clause.\n\nVERDICT: ${verdict}`
  : "unexpected role";
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 3000, output: 400, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } }, content: [{ type: "text", text }] } }));
