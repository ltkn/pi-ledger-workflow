/**
 * End-to-end tests of pb with a simulated Pi: commands, tools and events are the
 * extension's real ones; the "agent" is a script that reacts to each instruction by
 * writing files and calling pb's tools, and agent_settled fires after every run.
 * Run: npm test
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const { default: pb } = await import("../extensions/pb/index.ts");
const { parseSpec, addDecision } = await import("../extensions/pb/spec.ts");

type Tool = (name: string, params: object) => Promise<{ error?: string }>;
type Script = (instruction: string, tool: Tool) => Promise<void> | void;

function setup(config: object = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pb-test-"));
  execSync("git init -q && git config user.email t@t && git config user.name t && echo hi > README && git add . && git commit -qm init", { cwd: repo });
  fs.mkdirSync(path.join(repo, ".pi/pb"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".pi/pb/config.json"), JSON.stringify({ build: null, maxAttempts: 2, ...config }));

  const cmds: Record<string, any> = {};
  const tools: Record<string, any> = {};
  const handlers: Record<string, ((e: object, ctx: object) => unknown)[]> = {};
  const posts: string[] = [];
  const notes: string[] = [];
  const instructions: string[] = [];
  const selects: string[] = [];
  let activeTools = ["read", "bash", "edit", "write", "grep"];
  let sessionFile = path.join(repo, "planning-session.jsonl");
  let sessions = 0;
  const agent: { script?: Script } = {};

  const ctx: any = {
    cwd: repo,
    mode: "print",
    hasUI: true,
    isIdle: () => true,
    sessionManager: { getSessionFile: () => sessionFile },
    ui: {
      notify: (m: string) => notes.push(m),
      setWidget: () => {},
      setStatus: () => {},
      select: async (_t: string, opts: string[]) => selects.shift() ?? opts[0],
      confirm: async () => true,
      input: async () => "",
    },
    newSession: async (opts: { withSession?: (c: object) => Promise<void> }) => {
      sessionFile = path.join(repo, `build-session-${++sessions}.jsonl`);
      await opts.withSession?.({ ...ctx, sendMessage: async (m: any, o: any) => pi.sendMessage(m, o) });
      return { cancelled: false };
    },
  };

  // One agent run per instruction, queued like Pi's follow-ups; agent_settled after each.
  let running: Promise<void> = Promise.resolve();
  const callTool: Tool = async (name, params) => {
    try {
      return await tools[name].execute("call", params, undefined, undefined, ctx);
    } catch (e) {
      return { error: (e as Error).message };
    }
  };
  const turn = (text: string) => {
    instructions.push(text);
    running = running.then(async () => {
      await agent.script?.(text, callTool);
      for (const h of handlers.agent_settled ?? []) await h({ type: "agent_settled" }, ctx);
    });
  };
  const pi: any = {
    registerCommand: (n: string, o: object) => (cmds[n] = o),
    registerTool: (t: { name: string }) => (tools[t.name] = t),
    on: (e: string, h: (e: object, ctx: object) => unknown) => (handlers[e] ??= []).push(h),
    getActiveTools: () => activeTools,
    setActiveTools: (t: string[]) => (activeTools = t),
    sendMessage: (m: { content: string; display?: boolean }, o?: { triggerTurn?: boolean }) => {
      if (m.display) posts.push(m.content);
      if (o?.triggerTurn) turn(m.content);
    },
    sendUserMessage: (t: string) => turn(t),
  };
  pb(pi);

  const settle = async () => {
    let prev: Promise<void>;
    do {
      prev = running;
      await prev;
    } while (prev !== running);
  };
  const run = async (name: string, args = "") => {
    await cmds[`pb:${name}`].handler(args, ctx);
    await settle();
  };
  const read = (f: string) => fs.readFileSync(path.join(repo, f), "utf8");
  const progress = (name: string) => JSON.parse(read(`.pi/pb/specs/${name}/progress.json`));
  return { repo, cmds, tools, posts, notes, instructions, selects, agent, run, read, progress, callTool, settle, tools_: () => activeTools };
}

const SPEC = (opts: { verification?: string; newTests?: string; tasks?: string } = {}) => `# Order cancellation
Depends on: none
Verification: ${opts.verification ?? "tests"}
New tests: ${opts.newTests ?? "yes"}

## Goal
Cancel orders.
## Out of scope
Refunds.
## Decisions
- Only PENDING orders can be cancelled.
- Not doing soft delete, because audit lives elsewhere.
## Context
src/order.ts holds the model.
## Acceptance criteria
- T1.txt and T2.txt exist.
## Tasks
${
  opts.tasks ??
  `### T1: first file
Create T1.txt.
- Acceptance: T1.txt exists
- Test: \`test -f T1.txt\`

### T2: second file
Create T2.txt.
- Acceptance: T2.txt exists
- Test: \`test -f T2.txt\``
}
`;

/** An agent that reports no gaps, then does each task by creating <task>.txt. */
const diligent: Script = async (text, tool) => {
  if (text.includes("call pb_spec_gaps")) return void (await tool("pb_spec_gaps", { gaps: [] }));
  const task = text.match(/Task (T\d+)/)?.[1] ?? text.match(/task "(\w+)"/)?.[1];
  if (!task) return;
  if (task !== "final") fs.writeFileSync(`${task}.txt`, "x");
  await tool("pb_task_done", { task, status: "done", summary: `did ${task}` });
};

async function written(t: ReturnType<typeof setup>, spec = SPEC()) {
  process.chdir(t.repo);
  const r = await t.callTool("pb_write_spec", { name: "order-cancellation", content: spec });
  assert.equal(r.error, undefined, r.error ?? "");
}

/* --------------------------------- spec format --------------------------------- */

test("spec: parses the header, sections and tasks; says what's wrong otherwise", () => {
  const { spec, errors } = parseSpec(SPEC({ verification: "build — no suite for this module", newTests: "no — covered by T9" }));
  assert.deepEqual(errors, []);
  assert.equal(spec!.gate, "build");
  assert.equal(spec!.gateReason, "no suite for this module");
  assert.equal(spec!.newTests, false);
  assert.deepEqual(spec!.tasks.map((t) => [t.id, t.title, t.test]), [["T1", "first file", "test -f T1.txt"], ["T2", "second file", "test -f T2.txt"]]);

  const bad = parseSpec("# X\nVerification: none\n\n## Goal\n## Tasks\n### T1: a\nno acceptance\n");
  assert.ok(bad.errors.some((e) => e.includes('"Verification: none" needs a reason')));
  assert.ok(bad.errors.some((e) => e.includes('missing the "## Decisions" section')));
  assert.ok(bad.errors.some((e) => e.includes('T1 has no "- Acceptance:" line')));
});

test("spec: decisions are added under Decisions, before the next section", () => {
  const md = addDecision(SPEC(), "Cancelling twice is a no-op.");
  assert.match(md, /- Not doing soft delete, because audit lives elsewhere\.\n- Cancelling twice is a no-op\.\n\n## Context/);
});

/* --------------------------------- plan and spec --------------------------------- */

test("plan turns editing off and back on; spec asks for pb_write_spec", async () => {
  const t = setup({ verify: "true" });
  process.chdir(t.repo);
  await t.run("plan", "Add order cancellation");
  assert.deepEqual(t.tools_(), ["read", "bash", "grep"]);
  assert.match(t.instructions.at(-1)!, /\[pb:plan\] Add order cancellation[\s\S]*run `true` once/);
  await t.run("plan", "off");
  assert.ok(t.tools_().includes("edit") && t.tools_().includes("write"));
  await t.run("spec");
  assert.match(t.instructions.at(-1)!, /calling the pb_write_spec tool[\s\S]*Not doing X, because/);
});

test("pb_write_spec rejects a spec that doesn't parse, and a bad name", async () => {
  const t = setup();
  process.chdir(t.repo);
  assert.match((await t.callTool("pb_write_spec", { name: "x", content: "# only a title" })).error!, /doesn't parse[\s\S]*Verification/);
  assert.match((await t.callTool("pb_write_spec", { name: "Bad Name", content: SPEC() })).error!, /not a valid name/);
  await written(t);
  assert.deepEqual(t.progress("order-cancellation").tasks.map((x: any) => [x.id, x.status]), [["T1", "todo"], ["T2", "todo"]]);
});

/* ------------------------------------- build ------------------------------------- */

test("build: fresh session, gap check, tasks behind their tests, then the full suite", async () => {
  const t = setup({ verify: "test -f T1.txt && test -f T2.txt" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "built");
  assert.match(p.session, /build-session-1\.jsonl$/);
  assert.deepEqual(p.tasks.map((x: any) => [x.id, x.status]), [["T1", "done"], ["T2", "done"]]);
  assert.match(t.instructions[0], /fresh session, from the spec below and nothing else[\s\S]*call pb_spec_gaps[\s\S]*# Order cancellation/);
  assert.match(t.posts.at(-1)!, /BUILD COMPLETE — order-cancellation[\s\S]*PASS/);
  assert.match(t.read(".pi/pb/specs/order-cancellation/events.jsonl"), /"type":"check","task":"final"/); // full suite after the task tests
});

test("build: a failing check goes back to the agent, and passes on the next attempt", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  let lazy = true;
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T1") && lazy) {
      lazy = false; // first attempt forgets the file
      return void (await tool("pb_task_done", { task: "T1", status: "done", summary: "claimed" }));
    }
    return diligent(text, tool);
  };
  await t.run("build");
  assert.ok(t.instructions.some((i) => /The check for T1 failed \(attempt 2 of 2\)[\s\S]*test -f T1\.txt/.test(i)));
  assert.equal(t.progress("order-cancellation").phase, "built");
});

test("build: after the last attempt it pauses; /pb:build resumes with a fresh set", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  let give = false;
  t.agent.script = async (text, tool) => {
    if (text.includes("call pb_spec_gaps")) return void (await tool("pb_spec_gaps", { gaps: [] }));
    const task = text.match(/(?:Task|check for) (T\d+)/)?.[1];
    if (task === "T1" && !give) return void (await tool("pb_task_done", { task, status: "done", summary: "claimed" }));
    return diligent(text, tool);
  };
  await t.run("build");
  const p = t.progress("order-cancellation");
  assert.equal(p.phase, "paused");
  assert.match(t.posts.at(-1)!, /Build paused\*\* — T1 still fails after 2 attempts/);
  give = true;
  await t.run("build", "create the file in the repo root");
  assert.equal(t.progress("order-cancellation").phase, "built");
  assert.match(t.read(".pi/pb/specs/order-cancellation/spec.md"), /- create the file in the repo root/); // guidance recorded as a decision
});

test("build: gaps pause before any code; questions pause mid-build", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = async (text, tool) => {
    if (text.includes("call pb_spec_gaps")) return void (await tool("pb_spec_gaps", { gaps: ["Is cancelling twice an error?"] }));
    if (text.includes("Task T2")) return void (await tool("pb_task_done", { task: "T2", status: "question", summary: "", question: "Which file name?" }));
    return diligent(text, tool);
  };
  await t.run("build");
  assert.match(t.posts.at(-1)!, /Gaps in the spec[\s\S]*1\. Is cancelling twice an error\?/);
  assert.ok(!fs.existsSync(path.join(t.repo, "T1.txt")));

  await t.run("build", "cancelling twice is a no-op");
  assert.ok(fs.existsSync(path.join(t.repo, "T1.txt")));
  assert.match(t.posts.at(-1)!, /Build paused\*\* — T2 question: Which file name\?/);
});

test("build: pb_task_done must name the current task", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  let err: string | undefined;
  t.agent.script = async (text, tool) => {
    if (text.includes("call pb_spec_gaps")) return void (await tool("pb_spec_gaps", { gaps: [] }));
    if (text.includes("Task T1")) err ??= (await tool("pb_task_done", { task: "T2", status: "done", summary: "" })).error;
    return diligent(text, tool);
  };
  await t.run("build");
  assert.equal(err, "The current task is T1, not T2.");
});

test("build: verification none runs no checks; no new tests reaches the agent", async () => {
  const t = setup({ verify: "false" }); // would fail if it ran
  await written(t, SPEC({ verification: "none — docs only", newTests: "no — the human said so" }));
  t.agent.script = diligent;
  await t.run("build");
  assert.equal(t.progress("order-cancellation").phase, "built");
  assert.match(t.instructions[0], /New tests: NO for this feature \(the human said so\)[\s\S]*runs no checks for this feature \(docs only\)/);
});

test("build: fewer test cases in an existing test fail the task (gate: tests)", async () => {
  const t = setup({ verify: "true" });
  fs.mkdirSync(path.join(t.repo, "tests"));
  fs.writeFileSync(path.join(t.repo, "tests/test_a.py"), "def test_a():\n    pass\ndef test_b():\n    pass\n");
  execSync("git add . && git commit -qm tests", { cwd: t.repo });
  await written(t);
  t.agent.script = async (text, tool) => {
    if (text.includes("Task T1")) fs.writeFileSync("tests/test_a.py", "def test_a():\n    pass\n");
    if (text.includes("check for T1")) fs.writeFileSync("tests/test_a.py", "def test_a():\n    pass\ndef test_b():\n    pass\n");
    return diligent(text, tool);
  };
  await t.run("build");
  assert.ok(t.instructions.some((i) => /The check for T1 failed[\s\S]*existing tests were changed[\s\S]*2 → 1 test cases/.test(i)));
  assert.equal(t.progress("order-cancellation").phase, "built");
});

/* ------------------------------------- undo -------------------------------------- */

test("undo restores the files and tasks to before a task, and can be undone", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  t.agent.script = diligent;
  await t.run("build");
  t.agent.script = undefined;
  await t.run("undo", "T2");
  assert.ok(!fs.existsSync(path.join(t.repo, "T2.txt")) && fs.existsSync(path.join(t.repo, "T1.txt")));
  assert.deepEqual(t.progress("order-cancellation").tasks.map((x: any) => [x.id, x.status]), [["T1", "done"], ["T2", "todo"]]);
  assert.match(t.posts.at(-1)!, /Undone to before T2/);
  await t.run("undo", "u1");
  assert.ok(fs.existsSync(path.join(t.repo, "T2.txt")));
});

test("status lists every spec with its state and tasks", async () => {
  const t = setup({ verify: "true" });
  await written(t);
  await t.run("status");
  assert.match(t.notes.at(-1)!, /order-cancellation — written · verification tests/);
});
