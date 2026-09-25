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
  wf({
    registerCommand: (n: string, o: any) => (cmds[n] = o),
    sendMessage: (m: any) => m.display && posts.push(m.content),
  } as any);
  const ctx: any = {
    cwd: repo, mode: "print", hasUI: true, isIdle: () => true, model: { provider: "p", id: "m" }, thinkingLevel: "low",
    ui: { notify: () => {}, setWidget: () => {}, setStatus: () => {}, confirm: async () => true,
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
  return { cmds, posts, answers, run, read, init };
}

test("registers the five commands", () => {
  const { cmds } = setup("happy", {}, []);
  assert.deepEqual(Object.keys(cmds).sort(), ["wf:build", "wf:plan", "wf:review", "wf:scope", "wf:status"]);
});

test("happy path: question pause, answer, summarizer, completion, review follow-ups", async () => {
  const t = setup("happy", { verify: "test -f T1.txt" }, [{ id: "T1", title: "domain" }, { id: "T2", title: "endpoint" }, { id: "T3", title: "tests" }], "plan ASK_MANAGER");
  await t.init();

  await t.run("build"); // manager asks; empty inline answer → pause
  assert.match(t.posts.at(-1)!, /BUILD PAUSED/);
  assert.equal(JSON.parse(t.read("state.json")).phase, "paused");

  await t.run("build", "yes"); // answer via args → recorded, loop completes
  assert.match(t.posts.at(-1)!, /BUILD COMPLETE/);
  assert.match(t.read("decisions.md"), /Use soft delete\?\n\s+A: yes/);
  assert.match(t.read("log.md"), /partial — salvaged/); // cut-off summarizer used
  assert.match(t.read("assumptions.md"), /T1: used UTC/);
  assert.equal(t.read("notes.md").trim(), "notes after T3"); // rewritten, not appended

  await t.run("review");
  const tasks = JSON.parse(t.read("tasks.json")).tasks;
  assert.equal(tasks.at(-1).id, "R1");
  assert.equal(tasks.at(-1).status, "todo");
});

test("failing verification vetoes 'done', creates a fix task, and the stall guard stops the loop", async () => {
  const t = setup("failing", { verify: "echo '[ERROR] OrderTest expected PENDING'; exit 1", questions: "assume" }, [{ id: "T1", title: "a" }]);
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
