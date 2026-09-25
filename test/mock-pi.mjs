#!/usr/bin/env node
// Stand-in for a fresh `pi --mode json -p` child. Behaviour chosen by MOCK_SCENARIO.
import * as fs from "node:fs";
const argv = process.argv.slice(2);
const sys = fs.readFileSync(argv[argv.indexOf("--append-system-prompt") + 1], "utf8");
const attached = argv.find((a) => a.startsWith("@"));
const brief = attached ? fs.readFileSync(attached.slice(1), "utf8") : "";
const message = argv.at(-1);
// Sessions: the first run "persists" its brief; a resume (no attachment) finds it again.
const sid = argv.indexOf("--session-id");
const sessionFile = sid >= 0 ? `${argv[argv.indexOf("--session-dir") + 1]}/${argv[sid + 1]}.mock` : undefined;
if (sessionFile && brief) fs.writeFileSync(sessionFile, brief);
const scenario = process.env.MOCK_SCENARIO;
const say = (text) =>
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 1200, output: 150, cacheRead: 800, cacheWrite: 0, cost: { total: 0.001 } },
    content: [{ type: "toolCall", name: "read", arguments: { path: "x" } }, { type: "text", text }] } }));
const tasksIn = () => JSON.parse(brief.match(/## tasks.json\n\n([\s\S]*?)\n## /)[1]).tasks;

if (message.startsWith("You stopped before")) {
  // A resumed worker answers from its session, read-only.
  const readOnly = argv[argv.indexOf("--tools") + 1] === "read,grep,find,ls";
  if (!process.env.MOCK_NO_RESUME && readOnly && sessionFile && fs.existsSync(sessionFile)) {
    say("```wf-notes\nnotes from the resumed session\n```\n```wf-report\n" + JSON.stringify({ status: "partial", summary: "resumed with full context" }) + "\n```");
  } else say("still no report");
} else if (sys.includes("MANAGER")) {
  if (process.env.MOCK_BRIEF_OUT) fs.appendFileSync(process.env.MOCK_BRIEF_OUT, brief + "\n=====\n");
  if (scenario === "failing") {
    // Always claims everything is done: the harness must veto this.
    const tasks = tasksIn().map((t) => ({ ...t, status: "done" }));
    say("```wf-manage\n" + JSON.stringify({ tasks, next: null, done: true, rationale: "claims done" }) + "\n```");
  } else {
    const tasks = tasksIn();
    const next = tasks.find((t) => t.status !== "done" && t.status !== "dropped");
    const answered = fs.readFileSync(".pi/wf/decisions.md", "utf8").includes("A: yes");
    const q = brief.includes("ASK_MANAGER") && !answered ? "Use soft delete?" : null;
    // Delta: only the changed task is sent; the harness must keep order and untouched fields.
    const delta = [{ id: "T3", detail: "patched by manager" }];
    say("ok\n```wf-manage\n" + JSON.stringify({ tasks: delta, next: next?.id ?? null, instruction: "do it", done: !next, needs_input: q, rationale: "r" }) + "\n```");
  }
} else if (sys.includes("TESTER")) {
  // T1 gets a parked test; T2 is skipped; T3's file collides with an existing one; one stray write outside the spec dir.
  const ids = [...brief.split("## Write tests for")[1].split("\n## ")[0].matchAll(/^### (\w+):/gm)].map((m) => m[1]);
  const park = (id, rel, text) => {
    fs.mkdirSync(`.pi/wf/spec/${id}/${rel.split("/").slice(0, -1).join("/")}`, { recursive: true });
    fs.writeFileSync(`.pi/wf/spec/${id}/${rel}`, text);
  };
  if (ids.includes("T1")) park("T1", "tests/t1_spec_test.py", "def test_t1():\n    assert True\n");
  if (ids.includes("T3")) park("T3", "README", "clobber");
  fs.writeFileSync("stray.txt", "x");
  const tasks = ids.map((id) => (id === "T2" ? { id, tests: [], skip: "pure rename" } : { id, tests: [`test_${id.toLowerCase()}: checks ${id}`], skip: null }));
  say("```wf-tests\n" + JSON.stringify({ tasks, assumptions: [], spec_gaps: ["Is cancelling twice an error?"] }) + "\n```");
} else if (sys.includes("WORKER")) {
  const done = (id) => say("```wf-report\n" + JSON.stringify({ status: "done", summary: `did ${id}` }) + "\n```");
  if (scenario === "spec") {
    // T1's worker tries to edit its spec test: the harness must restore it.
    const id = brief.match(/task (\w+):/)[1];
    if (id === "T1" && fs.existsSync("tests/t1_spec_test.py")) fs.appendFileSync("tests/t1_spec_test.py", "# weakened\n");
    fs.writeFileSync(`${id}.txt`, "x");
    done(id);
  } else if (scenario === "revert") {
    // T2's first attempt wipes T1's file, like a stray `git checkout .`/`git stash` would.
    const id = brief.match(/task (\w+):/)[1];
    if (id === "T2" && !fs.existsSync("T2.txt")) fs.rmSync("T1.txt", { force: true });
    fs.writeFileSync(`${id}.txt`, "x");
    done(id);
  } else if (scenario === "tamper") {
    // Every attempt drops one test case from the existing test file (and claims done).
    const cur = (fs.readFileSync("tests/a_test.py", "utf8").match(/def test_/g) ?? []).length;
    fs.writeFileSync("tests/a_test.py", Array.from({ length: cur - 1 }, (_, i) => `def test_${i}():\n    assert True\n`).join(""));
    fs.appendFileSync("impl.txt", "x");
    done("T1");
  } else if (scenario === "stuck") {
    // Makes progress on disk every round but never finishes: exhausts the attempt limit.
    fs.appendFileSync("stuck.txt", "x");
    say("```wf-report\n" + JSON.stringify({ status: "partial", summary: "still going", notes: "n" }) + "\n```");
  } else if (scenario === "failing") {
    fs.writeFileSync("same.txt", "x");
    say("```wf-report\n" + JSON.stringify({ status: "done", summary: "tried", notes: "n" }) + "\n```");
  } else {
    const id = brief.match(/task (\w+):/)[1];
    fs.writeFileSync(`${id}.txt`, "x");
    if (id === "T2" && !fs.existsSync("T2.fixed")) {
      fs.writeFileSync("T2.fixed", "1");
      say("I ran out of room before writing a report"); // triggers the cut-off summarizer
    } else {
      // T1's summary carries a raw newline inside the JSON string (a small-model slip the parser repairs).
      const report = JSON.stringify({ status: "done", summary: id === "T1" ? "did T1 NEWLINE second line" : `did ${id}`, assumptions: id === "T1" ? ["used UTC"] : [] });
      say(`done\n\`\`\`wf-notes\nnotes after ${id}\n\`\`\`\n\`\`\`wf-report\n${report.replace(" NEWLINE ", "\n")}\n\`\`\``);
    }
  }
} else if (sys.includes("summarise")) {
  // Claims "done" (the harness must downgrade it) and has a trailing comma on purpose.
  say('```wf-notes\nsalvaged notes\n```\n```wf-report\n{"status":"done","summary":"salvaged",}\n```');
} else if (sys.includes("REVIEWER")) {
  say('Verdict: changes needed\n- missing X\n```wf-review\n{"verdict":"changes_needed","followups":[{"title":"Handle X"}]}\n```');
}
