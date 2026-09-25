#!/usr/bin/env node
// Stand-in for a fresh `pi --mode json -p` child. Behaviour chosen by MOCK_SCENARIO.
import * as fs from "node:fs";
const argv = process.argv.slice(2);
const sys = fs.readFileSync(argv[argv.indexOf("--append-system-prompt") + 1], "utf8");
const brief = fs.readFileSync(argv.find((a) => a.startsWith("@")).slice(1), "utf8");
const scenario = process.env.MOCK_SCENARIO;
const say = (text) =>
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { cost: { total: 0.001 } },
    content: [{ type: "toolCall", name: "read", arguments: { path: "x" } }, { type: "text", text }] } }));
const tasksIn = () => JSON.parse(brief.match(/## tasks.json\n\n([\s\S]*?)\n## /)[1]).tasks;

if (sys.includes("MANAGER")) {
  if (scenario === "failing") {
    // Always claims everything is done: the harness must veto this.
    const tasks = tasksIn().map((t) => ({ ...t, status: "done" }));
    say("```wf-manage\n" + JSON.stringify({ tasks, next: null, done: true, rationale: "claims done" }) + "\n```");
  } else {
    const tasks = tasksIn();
    const next = tasks.find((t) => t.status !== "done" && t.status !== "dropped");
    const answered = fs.readFileSync(".pi/wf/decisions.md", "utf8").includes("A: yes");
    const q = brief.includes("ASK_MANAGER") && !answered ? "Use soft delete?" : null;
    say("ok\n```wf-manage\n" + JSON.stringify({ tasks, next: next?.id ?? null, instruction: "do it", done: !next, needs_input: q, rationale: "r" }) + "\n```");
  }
} else if (sys.includes("WORKER")) {
  if (scenario === "failing") {
    fs.writeFileSync("same.txt", "x");
    say("```wf-report\n" + JSON.stringify({ status: "done", summary: "tried", notes: "n" }) + "\n```");
  } else {
    const id = brief.match(/task (\w+):/)[1];
    fs.writeFileSync(`${id}.txt`, "x");
    if (id === "T2" && !fs.existsSync("T2.fixed")) {
      fs.writeFileSync("T2.fixed", "1");
      say("I ran out of room before writing a report"); // triggers the cut-off summarizer
    } else {
      say("done\n```wf-report\n" + JSON.stringify({ status: "done", summary: `did ${id}`, notes: `notes after ${id}`, assumptions: id === "T1" ? ["used UTC"] : [] }) + "\n```");
    }
  }
} else if (sys.includes("summarise")) {
  say('```wf-report\n{"status":"partial","summary":"salvaged","notes":"salvaged notes",}\n```'); // trailing comma on purpose
} else if (sys.includes("REVIEWER")) {
  say('Verdict: changes needed\n- missing X\n```wf-review\n{"verdict":"changes_needed","followups":[{"title":"Handle X"}]}\n```');
}
