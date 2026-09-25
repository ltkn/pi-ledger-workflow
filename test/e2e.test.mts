/**
 * End-to-end tests of the build loop with a mock `pi` child (no model, no API key).
 * Run: npm test
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.PI_WF_PI_COMMAND = path.join(here, "mock-pi.mjs");
const { default: wf } = await import("../extensions/wf/index.ts");

function setup(scenario: string, config: object, tasks: object[], plan = "plan") {
  process.env.MOCK_SCENARIO = scenario;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wf-test-"));
  execSync("git init -q && git config user.email t@t && git config user.name t && echo hi > README && git add . && git commit -qm init", { cwd: repo });
  process.chdir(repo);
  const cmds: Record<string, any> = {};
  const posts: string[] = [];
  const answers: string[] = [];
  const confirms: boolean[] = [];
  const selects: string[] = [];
  wf({
    registerCommand: (n: string, o: any) => (cmds[n] = o),
    sendMessage: (m: any) => m.display && posts.push(m.content),
  } as any);
  const ctx: any = {
    cwd: repo, mode: "print", hasUI: true, isIdle: () => true, model: { provider: "p", id: "m" }, thinkingLevel: "low",
    ui: { notify: () => {}, setWidget: () => {}, setStatus: () => {}, confirm: async () => confirms.shift() ?? true,
      select: async (_t: string, opts: string[]) => selects.shift() ?? opts[0],
      input: async () => answers.shift() ?? "", onTerminalInput: () => () => {} },
  };
  const run = async (name: string, args = "") => cmds[`wf:${name}`].handler(args, ctx);
  const read = (f: string) => fs.readFileSync(path.join(repo, ".pi/wf", f), "utf8");
  const init = async () => {
    await run("scope", "Add order cancellation");
    fs.writeFileSync(".pi/wf/config.json", JSON.stringify(config));
    fs.writeFileSync(".pi/wf/plan.md", plan);
    fs.writeFileSync(".pi/wf/tasks.json", JSON.stringify({ tasks }));
  };
  return { cmds, posts, answers, confirms, selects, repo, run, read, init };
}

test("registers the nine commands", () => {
  const { cmds } = setup("happy", {}, []);
  assert.deepEqual(Object.keys(cmds).sort(), ["wf:build", "wf:help", "wf:plan", "wf:review", "wf:scope", "wf:stats", "wf:status", "wf:tests", "wf:undo"]);
});

test("/wf:help lists topics and shows one", async () => {
  const t = setup("happy", {}, []);
  await t.run("help");
  assert.match(t.posts.at(-1)!, /\/wf:help stuck-task/);
  await t.run("help", "stuck-task");
  assert.match(t.posts.at(-1)!, /## A task keeps failing/);
  await t.run("help", "nope");
  assert.match(t.posts.at(-1)!, /No help topic "nope"/);
});

test("attempt limit: guidance resets the counter, plain /wf:build asks for an answer", async () => {
  const t = setup("stuck", { verify: null, maxTaskAttempts: 2 }, [{ id: "T1", title: "a" }]);
  await t.init();
  const rounds = () => JSON.parse(t.read("state.json")).roundsTotal;

  await t.run("build"); // 2 attempts, then the limit question; empty inline answer → pause
  assert.match(t.posts.at(-1)!, /BUILD PAUSED/);
  assert.match(t.posts.at(-1)!, /T1 used all 2 attempts/);
  assert.equal(rounds(), 3);

  await t.run("build", "try the other mapper"); // T1 gets 2 fresh attempts before asking again
  assert.match(t.read("decisions.md"), /A: try the other mapper/);
  assert.equal(rounds(), 6);

  t.answers.push("split it"); // no args → prompted for the answer, then 2 more attempts
  await t.run("build");
  assert.match(t.read("decisions.md"), /A: split it/);
  assert.equal(rounds(), 9);
});

test("happy path: question pause, answer, summarizer, completion, review follow-ups", async () => {
  const t = setup("happy", { verify: "test -f T1.txt", specTests: false }, [{ id: "T1", title: "domain" }, { id: "T2", title: "endpoint" }, { id: "T3", title: "tests" }], "plan ASK_MANAGER");
  await t.init();

  await t.run("build"); // manager asks; empty inline answer → pause
  assert.match(t.posts.at(-1)!, /BUILD PAUSED/);
  assert.match(t.posts.at(-1)!, /\*\*What now\*\*[\s\S]*\/wf:help decisions/); // situational help
  assert.equal(JSON.parse(t.read("state.json")).phase, "paused");

  await t.run("build", "yes"); // answer via args → recorded, loop completes
  assert.match(t.posts.at(-1)!, /BUILD COMPLETE/);
  assert.match(t.read("decisions.md"), /Use soft delete\?\n\s+A: yes/);
  assert.match(t.read("log.md"), /partial — resumed with full context/); // the worker's own session wrote the missing report
  assert.match(t.read("log.md"), /did T1\nsecond line/); // raw newline inside a JSON string repaired
  const built = JSON.parse(t.read("tasks.json")).tasks;
  assert.deepEqual(built.map((x: any) => x.id), ["T1", "T2", "T3"]); // delta merge keeps order
  assert.equal(built[2].title, "tests"); // untouched fields kept
  assert.equal(built[2].detail, "patched by manager");
  assert.match(t.read("assumptions.md"), /T1: used UTC/);
  assert.equal(t.read("notes.md").trim(), "notes after T3"); // rewritten, not appended

  await t.run("review");
  const tasks = JSON.parse(t.read("tasks.json")).tasks;
  assert.equal(tasks.at(-1).id, "R1");
  assert.equal(tasks.at(-1).status, "todo");
});

test("failing verification vetoes 'done', creates a fix task, and the stall guard stops the loop", async () => {
  const t = setup("failing", { verify: "echo '[ERROR] OrderTest expected PENDING'; exit 1", questions: "assume", specTests: false }, [{ id: "T1", title: "a" }]);
  await t.init();
  await t.run("build");
  const out = t.posts.at(-1)!;
  assert.match(out, /BUILD STALLED/);
  assert.doesNotMatch(out, /BUILD COMPLETE/);
  const tasks = JSON.parse(t.read("tasks.json")).tasks;
  assert.equal(tasks.find((x: any) => x.id === "T1").status, "doing");
  assert.ok(tasks.some((x: any) => x.id === "F1"));
  assert.match(t.read("log.md"), /finish vetoed \(verification failing\)/);

  await t.run("build", "try the other mapper"); // guidance on a stalled build is recorded
  assert.match(t.read("decisions.md"), /A: try the other mapper/);
});

test("manager cannot finish before any work happened (empty workspace)", async () => {
  const t = setup("failing", { verify: null, questions: "assume", maxRounds: 1 }, [{ id: "T1", title: "a" }]);
  await t.init();
  await t.run("build");
  assert.doesNotMatch(t.posts.at(-1)!, /BUILD COMPLETE/);
  assert.match(t.read("log.md"), /finish vetoed \(unfinished tasks\)/);
});

test("prompts: placeholders filled; worker brief has the verify command and the previous attempt", async () => {
  const { managerSystem, workerSystem, workerBrief } = await import("../extensions/wf/prompts.ts");
  const { DEFAULT_CONFIG } = await import("../extensions/wf/ledger.ts");
  for (const p of [managerSystem(DEFAULT_CONFIG), workerSystem(DEFAULT_CONFIG)]) assert.doesNotMatch(p, /ATTEMPT_LIMIT|QUESTION_POLICY|NOTES_CAP/);

  const led: any = { read: () => "" };
  const st: any = { lastReport: { task: "T2", status: "partial", summary: "records done, tests remain" } };
  const brief = workerBrief(led, DEFAULT_CONFIG, st, { id: "T2", title: "t", status: "doing", attempts: 2 }, "", "mvn -q test");
  assert.match(brief, /attempt 2 of 4/);
  assert.match(brief, /`mvn -q test`/);
  assert.match(brief, /## Previous attempt at this task\n\npartial: records done, tests remain/);
  assert.doesNotMatch(workerBrief(led, DEFAULT_CONFIG, st, { id: "T3", title: "t", status: "doing", attempts: 1 }, "", null), /Previous attempt/);
});

test("checkpoints: lost work is detected and restored on confirm", async () => {
  const t = setup("revert", { verify: null }, [{ id: "T1", title: "a" }, { id: "T2", title: "b" }]);
  await t.init();
  await t.run("build");
  const out = t.posts.at(-1)!;
  assert.match(out, /BUILD COMPLETE/);
  assert.match(out, /⚑ Harness flags[\s\S]*lost-work: reverted earlier tasks' work in T1\.txt \(restored by the human\)/);
  assert.ok(fs.existsSync(path.join(t.repo, "T1.txt"))); // restored
  assert.match(t.read("decisions.md"), /the human restored it/);
});

test("checkpoints: declining the restore pauses with the undo hint", async () => {
  const t = setup("revert", { verify: null }, [{ id: "T1", title: "a" }, { id: "T2", title: "b" }]);
  await t.init();
  t.confirms.push(false);
  await t.run("build");
  const out = t.posts.at(-1)!;
  assert.match(out, /BUILD PAUSED/);
  assert.match(out, /\/wf:undo r\d+/);
  assert.equal(JSON.parse(t.read("state.json")).pause.kind, "lost-work");
  assert.ok(!fs.existsSync(path.join(t.repo, "T1.txt")));
});

test("checkpoints: fewer test cases block done, the second time pauses", async () => {
  const t = setup("tamper", { verify: null }, [{ id: "T1", title: "a" }]);
  fs.mkdirSync(path.join(t.repo, "tests"));
  fs.writeFileSync(path.join(t.repo, "tests/a_test.py"), "def test_a():\n    pass\ndef test_b():\n    pass\ndef test_c():\n    pass\n");
  execSync("git add . && git commit -qm tests", { cwd: t.repo });
  await t.init();
  await t.run("build"); // round 1: 3 → 2 (flag, not done); round 2: 2 → 1 (second flag → ask; empty → pause)
  const out = t.posts.at(-1)!;
  assert.match(out, /BUILD PAUSED/);
  assert.match(out, /changed existing tests twice/);
  assert.match(t.read("log.md"), /tampering: tests\/a_test\.py: 3 → 2 test cases/);
  assert.equal(JSON.parse(t.read("tasks.json")).tasks[0].status, "doing");
  assert.equal(JSON.parse(t.read("state.json")).pause.kind, "tampering");
});

test("/wf:undo restores files and tasks, and can be undone", async () => {
  const t = setup("happy", { verify: null }, [{ id: "T1", title: "domain" }, { id: "T2", title: "endpoint" }, { id: "T3", title: "tests" }]);
  const briefs = path.join(t.repo, "..", `${path.basename(t.repo)}-briefs.md`);
  process.env.MOCK_BRIEF_OUT = briefs;
  await t.init();
  await t.run("build");
  delete process.env.MOCK_BRIEF_OUT;
  assert.match(t.posts.at(-1)!, /BUILD COMPLETE/);
  assert.match(fs.readFileSync(briefs, "utf8"), /actually changed \(harness diff\)\n\nT1\.txt \| 1 \+/); // manager sees the real diff
  const head = execSync("git rev-parse HEAD", { cwd: t.repo, encoding: "utf8" });
  const cps = JSON.parse(t.read("checkpoints.json"));
  const r3 = cps.find((c: any) => c.task === "T3");
  assert.ok(cps[0].id === "start" && r3);

  await t.run("undo", `${r3.id} wrong approach`);
  assert.ok(!fs.existsSync(path.join(t.repo, "T3.txt")));
  assert.ok(fs.existsSync(path.join(t.repo, "T2.txt")));
  assert.equal(JSON.parse(t.read("tasks.json")).tasks[2].status, "todo");
  assert.match(t.read("decisions.md"), /undid rounds r\d+[^:]*: wrong approach/);
  assert.match(t.posts.at(-1)!, /Undone to before r\d+/);

  assert.equal(execSync("git rev-parse HEAD", { cwd: t.repo, encoding: "utf8" }), head); // branch untouched
  assert.equal(execSync("git diff --cached --name-only", { cwd: t.repo, encoding: "utf8" }), ""); // staging area untouched

  await t.run("undo", "u1"); // back to where we were
  assert.ok(fs.existsSync(path.join(t.repo, "T3.txt")));
  assert.equal(JSON.parse(t.read("tasks.json")).tasks[2].status, "done");
});

test("spec tests: written parked, activated with the task, restored after a worker edits them", async () => {
  const t = setup("spec", { verify: "true" }, [{ id: "T1", title: "a" }, { id: "T2", title: "b" }, { id: "T3", title: "c" }]);
  await t.init();
  await t.run("tests");
  const spec = JSON.parse(t.read("spec.json"));
  assert.deepEqual(spec.tasks.T1.files, ["tests/t1_spec_test.py"]);
  assert.equal(spec.tasks.T2.skip, "pure rename");
  assert.equal(spec.tasks.T3, undefined); // README exists in the repo: dropped
  const out = t.posts.at(-1)!;
  assert.match(out, /Gaps in the spec[\s\S]*cancelling twice/);
  assert.match(out, /T3: README already exists/);
  assert.match(out, /wrote outside[\s\S]*stray\.txt/);
  assert.ok(!fs.existsSync(path.join(t.repo, "stray.txt"))); // reverted
  assert.ok(!fs.existsSync(path.join(t.repo, "tests/t1_spec_test.py"))); // parked, not in the code yet
  assert.match(t.read("spec/index.md"), /## T1[\s\S]*tests\/t1_spec_test\.py/);

  await t.run("build");
  assert.match(t.posts.at(-1)!, /BUILD COMPLETE/);
  assert.equal(fs.readFileSync(path.join(t.repo, "tests/t1_spec_test.py"), "utf8"), "def test_t1():\n    assert True\n"); // restored
  assert.match(t.read("log.md"), /Notices: spec tests edited or removed by the worker, restored: tests\/t1_spec_test\.py/);
});

test("spec tests: never skipped silently", async () => {
  const t = setup("spec", { verify: "true" }, [{ id: "T1", title: "a" }]);
  await t.init();
  await t.run("build"); // default choice: stop and write them first
  assert.match(t.posts.at(-1)!, /\/wf:tests/);
  assert.equal(JSON.parse(t.read("state.json")).roundsTotal, 0);

  t.selects.push("Build without spec tests for this feature");
  t.answers.push("spike");
  await t.run("build");
  assert.match(t.posts.at(-1)!, /BUILD COMPLETE/);
  assert.deepEqual(JSON.parse(t.read("spec.json")), { status: "skipped", reason: "spike", tasks: {} });
  assert.match(t.read("decisions.md"), /Build without spec tests: spike/);
});

test("/wf:stats: feature card with reliability and tokens per role; all features grouped by model", async () => {
  const t = setup("happy", { verify: null }, [{ id: "T1", title: "domain" }, { id: "T2", title: "endpoint" }, { id: "T3", title: "tests" }]);
  await t.init();
  await t.run("build");
  await t.run("review");
  await t.run("stats");
  const card = t.posts.at(-1)!;
  if (process.env.SHOW_STATS) console.log(card);
  assert.match(card, /Tasks +3 done of 4 · planned 3 · review \+1/);
  assert.match(card, /Rounds +4 worker rounds · 1\.3 per done task · first try 2\/3 \(67%\) · most: T2 \(2\)/);
  assert.match(card, /reports 3 ok, 1 resumed, 0 salvaged, 0 lost · manager decisions missing 0\/\d+/);
  assert.match(card, /\nresume +1 /);
  assert.match(card, /Review +changes_needed \(1 R-tasks\)/);
  assert.match(card, /\nworker +4 +2\.0k +2\.0k +8\.0k +600 +40%/); // 4 calls · peak 2.0k · prompt 4×2000 · output 4×150 · 800/2000 cached
  assert.match(card, /\ntotal /);

  await t.run("scope", "Next feature"); // archives the first one
  await t.run("stats", "all");
  const all = t.posts.at(-1)!;
  if (process.env.SHOW_STATS) console.log(all);
  assert.match(all, /── worker: p\/m · manager: p\/m · 1 feature\(s\)/);
  assert.doesNotMatch(all, /older feature/); // the new, empty feature isn't "built before stats"
  assert.match(all, /Add order cancellation +3\/4 +1\.3 +67% +1 +0 +0 +changes \+1R/);
});

test("missing report: resume fails → summarizer fallback; sessions are always deleted", async () => {
  const sessions = () => fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("pi-wf-session-")).sort();
  const before = sessions();
  const t = setup("happy", { verify: null }, [{ id: "T1", title: "domain" }, { id: "T2", title: "endpoint" }, { id: "T3", title: "tests" }]);
  await t.init();
  process.env.MOCK_NO_RESUME = "1";
  await t.run("build");
  delete process.env.MOCK_NO_RESUME;
  assert.match(t.posts.at(-1)!, /BUILD COMPLETE/);
  assert.match(t.read("log.md"), /partial — salvaged/); // summarizer used; its "done" downgraded
  assert.deepEqual(sessions(), before);
});
