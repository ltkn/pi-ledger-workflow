/**
 * pi-plan-build (pb): plan a feature with Pi, turn it into a self-contained spec,
 * build it in a fresh session task by task behind a check the harness runs, and
 * have it reviewed with fresh eyes.
 *
 *   /pb:plan <feature>     plan together (edit/write off)
 *   /pb:spec [which]       write the spec(s) from the discussion
 *   /pb:build [name]       build a spec in a new session; resumes after a pause
 *   /pb:undo [id]          restore the working tree to before a task
 *   /pb:status             every spec and where it stands
 *   /pb:help [topic]       what to do next
 *
 * Inspired by GVS5H (Gao et al., arXiv:2608.26480): small tasks, a verifier that
 * outranks the model's own "done", and fresh eyes against anchoring.
 */
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { changedPaths, dropCheckpoints, inspectRound, restore, snapshot } from "./checkpoint.ts";
import { HELP_PATH, tip, topic, topics } from "./help.ts";
import { buildSeed, fixPrompt, planPrompt, specPrompt, taskPrompt } from "./prompts.ts";
import { type ParsedSpec, SPEC_NAME, addDecision, parseSpec } from "./spec.ts";
import { type Checkpoint, type Progress, type Report, type TaskProgress, PREFIX, Store, gitHead, now } from "./store.ts";
import { resolveBuild, resolveVerify, runVerify } from "./verify.ts";

const cmd = (verb: string) => `${PREFIX}:${verb}`;
const EDIT_TOOLS = ["edit", "write"];

export default function pb(pi: ExtensionAPI) {
  /* ------------------------------- helpers ------------------------------- */

  /** Visible in the session, and part of its context so you can discuss it. */
  const post = (content: string) => pi.sendMessage({ customType: "pb", content, display: true }, { triggerTurn: false });
  /** A short visible marker plus full instructions that start a turn. */
  const instruct = (marker: string, prompt: string) => {
    post(marker);
    pi.sendMessage({ customType: "pb-instruction", content: prompt, display: false }, { triggerTurn: true, deliverAs: "followUp" });
  };

  const commands = (cwd: string, store: Store) => {
    const cfg = store.config();
    return { cfg, testCmd: resolveVerify(cfg.verify, cwd), buildCmd: resolveBuild(cfg.build, cwd) };
  };

  const loadSpec = (store: Store, name: string): { md: string; spec: ParsedSpec } | undefined => {
    const md = store.readSpec(name);
    const spec = md ? parseSpec(md).spec : undefined;
    return md && spec ? { md, spec } : undefined;
  };

  /** Keep task statuses by id when a spec is (re)written; new tasks start as todo. */
  const syncTasks = (spec: ParsedSpec, old: TaskProgress[] = []): TaskProgress[] =>
    spec.tasks.map((t) => {
      const prev = old.find((o) => o.id === t.id);
      return { id: t.id, title: t.title, status: prev?.status ?? "todo", attempts: prev?.attempts ?? 0 };
    });

  const taskLine = (t: TaskProgress) => `${t.status === "done" ? "✓" : t.status === "doing" ? "▸" : t.status === "blocked" ? "✗" : "·"} ${t.id} ${t.title}${t.attempts > 1 ? ` (${t.attempts} attempts)` : ""}`;

  const specOfSession = (ctx: ExtensionContext) => {
    const store = new Store(ctx.cwd);
    const name = store.specForSession(ctx.sessionManager.getSessionFile());
    return { store, name, progress: name ? store.progress(name) : undefined };
  };

  /* -------------------------------- tools -------------------------------- */

  pi.registerTool({
    name: "pb_write_spec",
    label: "Write spec",
    description:
      "Write or rewrite a pb feature spec (.pi/pb/specs/<name>/spec.md). Use it when the user runs /pb:spec. The content must follow the spec format the user's instructions give; the tool rejects a spec that doesn't parse and says why.",
    parameters: Type.Object({
      name: Type.String({ description: "short kebab-case name, e.g. order-cancellation" }),
      content: Type.String({ description: "the complete spec in markdown" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!SPEC_NAME.test(params.name)) throw new Error(`"${params.name}" is not a valid name: use short kebab-case, e.g. order-cancellation`);
      const { spec, errors } = parseSpec(params.content);
      if (!spec) throw new Error(`The spec doesn't parse:\n- ${errors.join("\n- ")}\nFix it and call pb_write_spec again.`);
      const store = new Store(ctx.cwd);
      const prev = store.progress(params.name);
      store.writeSpec(params.name, params.content);
      store.saveProgress({ ...(prev ?? { spec: params.name, phase: "written" }), spec: params.name, tasks: syncTasks(spec, prev?.tasks), updatedAt: now() });
      store.event(params.name, { type: "spec", tasks: spec.tasks.length, gate: spec.gate, newTests: spec.newTests });
      return {
        content: [
          {
            type: "text",
            text: `Wrote ${store.rel("specs", params.name, "spec.md")}: "${spec.title}", ${spec.tasks.length} tasks, verification ${spec.gate}${spec.newTests ? "" : ", no new tests"}${spec.dependsOn ? `, depends on ${spec.dependsOn}` : ""}.`,
          },
        ],
        details: { name: params.name },
      };
    },
  });

  pi.registerTool({
    name: "pb_spec_gaps",
    label: "Spec gaps",
    description: "In a pb build session, before any code: report gaps, contradictions or mismatches between the spec and the code (an empty list if none).",
    parameters: Type.Object({ gaps: Type.Array(Type.String(), { description: "one precise gap per item, with where it matters" }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { store, progress } = specOfSession(ctx);
      if (!progress) throw new Error("This is not a pb build session.");
      progress.gaps = params.gaps.map((g) => g.trim()).filter(Boolean);
      store.saveProgress(progress);
      return { content: [{ type: "text", text: progress.gaps.length ? "Recorded; the human will answer them." : "Recorded: no gaps." }], details: undefined, terminate: true };
    },
  });

  pi.registerTool({
    name: "pb_record_decision",
    label: "Record decision",
    description: "In a pb build session: record a decision the human just made, in the spec's Decisions section, so it survives compaction and reaches the reviewer.",
    parameters: Type.Object({ decision: Type.String({ description: "the decision, self-contained, in one or two sentences" }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { store, name } = specOfSession(ctx);
      const md = name ? store.readSpec(name) : undefined;
      if (!name || !md) throw new Error("This is not a pb build session.");
      store.writeSpec(name, addDecision(md, params.decision));
      return { content: [{ type: "text", text: "Recorded in the spec's Decisions." }], details: undefined };
    },
  });

  pi.registerTool({
    name: "pb_task_done",
    label: "Task done",
    description: "In a pb build session: finish the task the harness gave you. status: done (complete and checked), blocked (can't be done properly; say why), question (you need the human's decision).",
    parameters: Type.Object({
      task: Type.String({ description: 'the task id, e.g. "T2" (or "final" for the final check)' }),
      status: StringEnum(["done", "blocked", "question"]),
      summary: Type.String({ description: "what you changed and why, and what you checked with what result" }),
      question: Type.Optional(Type.String({ description: "with status question: one precise question, with options and your recommendation" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const { store, progress } = specOfSession(ctx);
      if (!progress) throw new Error("This is not a pb build session.");
      if (params.task !== progress.current) throw new Error(`The current task is ${progress.current ?? "none"}, not ${params.task}.`);
      progress.report = { task: params.task, status: params.status as Report["status"], summary: params.summary, question: params.question };
      store.saveProgress(progress);
      return { content: [{ type: "text", text: "Reported to the harness." }], details: undefined, terminate: true };
    },
  });

  /* --------------------------------- plan -------------------------------- */

  pi.registerCommand(cmd("plan"), {
    description: "Plan a feature together (editing off). /pb:plan off turns editing back on",
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === "off") {
        pi.setActiveTools([...new Set([...pi.getActiveTools(), ...EDIT_TOOLS])]);
        return ctx.ui.notify("Planning mode off: editing is back on.", "info");
      }
      if (!arg) return ctx.ui.notify(`Usage: /${cmd("plan")} <feature>`, "warning");
      const store = new Store(ctx.cwd);
      const { testCmd } = commands(ctx.cwd, store);
      pi.setActiveTools(pi.getActiveTools().filter((t) => !EDIT_TOOLS.includes(t)));
      instruct(`▶ /${cmd("plan")} — ${arg} (editing off)`, planPrompt(arg, testCmd));
    },
  });

  /* --------------------------------- spec -------------------------------- */

  pi.registerCommand(cmd("spec"), {
    description: "Write the spec(s) for what we planned; rerun to revise",
    handler: async (args, ctx) => {
      const store = new Store(ctx.cwd);
      instruct(`▶ /${cmd("spec")}${args.trim() ? ` — ${args.trim()}` : ""}`, specPrompt(args.trim(), store.specNames()));
    },
  });

  /* --------------------------------- build ------------------------------- */

  /** Snapshot and hand the agent a task (a new task gets an undo entry). */
  const startTask = (ctx: ExtensionContext, store: Store, p: Progress, taskId: string, guidance = "") => {
    const loaded = loadSpec(store, p.spec);
    const task = loaded?.spec.tasks.find((t) => t.id === taskId);
    const tp = p.tasks.find((t) => t.id === taskId);
    if (!loaded || !task || !tp) return;
    const cfg = store.config();
    if (tp.status === "todo" && cfg.checkpoints) {
      const snap = snapshot(ctx.cwd, `pb: before ${p.spec} ${taskId}`);
      if (snap) {
        const list = store.checkpoints(p.spec);
        list.push({ id: taskId, at: now(), ...snap, head: gitHead(ctx.cwd), tasks: structuredClone(p.tasks), task: taskId });
        store.saveCheckpoints(p.spec, list);
      }
    }
    tp.status = "doing";
    tp.attempts += 1;
    p.current = taskId;
    p.report = undefined;
    p.pause = undefined;
    p.phase = "building";
    store.saveProgress(p);
    instruct(`▶ ${taskId}: ${task.title}${tp.attempts > 1 ? ` (attempt ${tp.attempts})` : ""}`, taskPrompt(task, tp.attempts, cfg.maxAttempts) + (guidance ? `\n\nFrom the human: ${guidance}` : ""));
  };

  const pause = (store: Store, p: Progress, reason: string, tipKey: string, vars: Record<string, string | number> = {}) => {
    p.phase = "paused";
    p.pause = reason;
    store.saveProgress(p);
    post(`**⏸ Build paused** — ${reason}\n\n${tip(tipKey, { spec: p.spec, ...vars })}`);
  };

  const nextTodo = (p: Progress) => p.tasks.find((t) => t.status === "doing" || t.status === "todo");

  /** Run the gate for the current task (or the final check). Returns the failure text, or undefined when it passes. */
  const runGate = async (ctx: ExtensionContext, store: Store, p: Progress, spec: ParsedSpec, final: boolean): Promise<string | undefined> => {
    const { cfg, testCmd, buildCmd } = commands(ctx.cwd, store);
    const task = spec.tasks.find((t) => t.id === p.current);
    const command = spec.gate === "tests" ? (final ? testCmd : (task?.test ?? testCmd)) : spec.gate === "build" ? buildCmd : null;
    if (!command) return undefined;
    ctx.ui.setWidget("pb", [`pb ${p.spec} — checking ${final ? "everything" : p.current}: ${command}`]);
    try {
      p.lastVerify = await runVerify(command, ctx.cwd, cfg.verifyTimeoutSec, cfg.testOutputCap);
    } finally {
      ctx.ui.setWidget("pb", undefined);
    }
    store.saveProgress(p);
    return p.lastVerify.ok === false ? p.lastVerify.summary : undefined;
  };

  /** Test-integrity check around a task: deleted, cut down or skipped existing tests fail the task. */
  const inspectTask = (ctx: ExtensionContext, store: Store, p: Progress, spec: ParsedSpec) => {
    const cps = store.checkpoints(p.spec);
    const entry = cps.find((c) => c.id === p.current);
    const start = cps[0];
    const post_ = entry && store.config().checkpoints ? snapshot(ctx.cwd, `pb: after ${p.spec} ${p.current}`) : undefined;
    if (!entry || !start || !post_) return { tampering: undefined as string | undefined, notices: [] as string[] };
    const others = new Set(cps.filter((c) => c.task && c.task !== p.current).flatMap((c) => c.files ?? []));
    const flags = inspectRound(ctx.cwd, entry, post_, start, others);
    entry.files = changedPaths(ctx.cwd, entry.commit, post_.commit);
    store.saveCheckpoints(p.spec, cps);
    const tamper = flags.find((f) => f.kind === "tampering");
    return {
      tampering: spec.gate === "tests" ? tamper?.detail : undefined,
      notices: flags.filter((f) => f.kind === "lost-work" || (f.kind === "tampering" && spec.gate !== "tests")).map((f) => `${f.kind}: ${f.detail}`),
    };
  };

  /** Called whenever the agent has finished a run in this session: move the build forward. */
  let driving = false;
  const drive = async (ctx: ExtensionContext) => {
    const { store, progress: p } = specOfSession(ctx);
    if (driving || !p || (p.phase !== "checking" && p.phase !== "building")) return;
    const loaded = loadSpec(store, p.spec);
    if (!loaded) return pause(store, p, `${store.rel("specs", p.spec, "spec.md")} no longer parses; fix it, then /${cmd("build")}.`, "build.paused");

    if (p.phase === "checking") {
      if (!p.gaps) return pause(store, p, "the spec check ended without a report.", "build.paused");
      if (p.gaps.length) {
        p.phase = "paused";
        p.pause = "spec gaps";
        store.saveProgress(p);
        return post(`**⏸ Gaps in the spec** — answer them here before any code is written:\n\n${p.gaps.map((g, i) => `${i + 1}. ${g}`).join("\n")}\n\n${tip("build.gaps")}`);
      }
      const first = nextTodo(p);
      return first ? startTask(ctx, store, p, first.id) : undefined;
    }

    const r = p.report;
    if (!r || r.task !== p.current) return pause(store, p, "the agent stopped without finishing its task (a question in chat, or you stopped it).", "build.paused");
    if (r.status !== "done") return pause(store, p, `${r.task} ${r.status}: ${r.question ?? r.summary}`, "build.paused");

    driving = true;
    try {
      const final = p.current === "final";
      const { cfg } = commands(ctx.cwd, store);
      const integrity = final ? { tampering: undefined, notices: [] } : inspectTask(ctx, store, p, loaded.spec);
      const failure = integrity.tampering ? `existing tests were changed: ${integrity.tampering}` : await runGate(ctx, store, p, loaded.spec, final);
      const tp = p.tasks.find((t) => t.id === p.current);
      store.event(p.spec, { type: "check", task: p.current, attempt: tp?.attempts ?? 1, ok: !failure, notices: integrity.notices });
      if (failure) {
        const attempts = tp?.attempts ?? (p.lastVerify ? 1 : 0);
        if (attempts >= cfg.maxAttempts) {
          if (tp) tp.status = "doing";
          return pause(store, p, `${p.current} still fails after ${attempts} attempts.`, "build.paused-attempts", { task: p.current ?? "" });
        }
        if (tp) tp.attempts += 1;
        p.report = undefined;
        store.saveProgress(p);
        return instruct(`✗ ${p.current} check failed (attempt ${attempts})`, fixPrompt(p.current!, integrity.tampering ? "existing tests were changed" : `\`${p.lastVerify?.command}\``, failure, attempts + 1, cfg.maxAttempts));
      }

      // Passed: close the task and move on.
      if (tp) tp.status = "done";
      const cps = store.checkpoints(p.spec);
      const entry = cps.find((c) => c.id === p.current);
      if (entry) {
        entry.summary = `${p.current} ✓ · ${(entry.files ?? []).length} files · ${r.summary.replace(/\s+/g, " ").slice(0, 70)}`;
        store.saveCheckpoints(p.spec, cps);
      }
      const notices = integrity.notices.length ? `\n⚠ ${integrity.notices.join("\n⚠ ")}` : "";
      const next = nextTodo(p);
      if (next) {
        post(`✓ ${p.current} ${loaded.spec.gate === "none" ? "done (no checks for this feature)" : `passed (\`${p.lastVerify?.command}\`)`}${notices}`);
        return startTask(ctx, store, p, next.id);
      }
      // Every task passed: one full check, unless the last one already was.
      const { testCmd } = commands(ctx.cwd, store);
      if (!final && loaded.spec.gate === "tests" && testCmd && p.lastVerify?.command !== testCmd) {
        post(`✓ ${p.current} passed${notices}\nRunning the full suite…`);
        p.current = "final";
        p.report = { task: "final", status: "done", summary: "final check" };
        p.tasks.push({ id: "final", title: "Final check: full suite", status: "doing", attempts: 1 });
        store.saveProgress(p);
        driving = false;
        return drive(ctx);
      }
      p.tasks = p.tasks.filter((t) => t.id !== "final");
      p.phase = "built";
      p.current = undefined;
      p.report = undefined;
      store.saveProgress(p);
      store.event(p.spec, { type: "built" });
      post(
        [
          `**✅ BUILD COMPLETE — ${p.spec}**${notices}`,
          "",
          "```",
          ...p.tasks.map(taskLine),
          "```",
          `Check: ${p.lastVerify?.summary.split("\n")[0] ?? `none (verification ${loaded.spec.gate})`}`,
          "",
          tip("build.done", { spec: p.spec }),
        ].join("\n"),
      );
    } finally {
      driving = false;
    }
  };

  pi.on("agent_settled", async (_e, ctx) => {
    await drive(ctx);
  });

  pi.registerCommand(cmd("build"), {
    description: "Build a spec in a fresh session, task by task behind a check. In a build session: resume after a pause",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
      const store = new Store(ctx.cwd);
      const words = args.trim().split(/\s+/).filter(Boolean);

      // Inside a build session: resume.
      const here = specOfSession(ctx);
      if (here.name && here.progress) {
        const p = here.progress;
        const guidance = args.trim();
        if (p.phase === "built" || p.phase === "reviewed") return ctx.ui.notify(`${p.spec} is built. Next: /${cmd("review")}.`, "info");
        if (guidance) {
          const md = store.readSpec(p.spec);
          if (md) store.writeSpec(p.spec, addDecision(md, guidance));
        }
        if (p.pause === "spec gaps" || (p.phase === "checking" && !p.current)) {
          const first = nextTodo(p);
          return first ? startTask(ctx, store, p, first.id, guidance) : undefined;
        }
        if (p.current === "final") {
          const fin = p.tasks.find((t) => t.id === "final");
          if (fin) fin.attempts = 1;
          p.report = undefined;
          p.phase = "building";
          p.pause = undefined;
          store.saveProgress(p);
          return instruct("▶ final check", fixPrompt("final", `\`${p.lastVerify?.command ?? "the full suite"}\``, p.lastVerify?.summary ?? "", 1, store.config().maxAttempts) + (guidance ? `\n\nFrom the human: ${guidance}` : ""));
        }
        const cur = p.current ?? nextTodo(p)?.id;
        if (!cur) return ctx.ui.notify("Nothing left to build here.", "info");
        const tp = p.tasks.find((t) => t.id === cur);
        if (tp && tp.attempts >= store.config().maxAttempts) tp.attempts = 0; // your answer buys a fresh set of attempts
        return startTask(ctx, store, p, cur, guidance);
      }

      // Otherwise: pick a spec and open its build session.
      const open = store.specNames().filter((n) => {
        const ph = store.progress(n)?.phase;
        return ph === "written" || ph === undefined;
      });
      let name = words[0] && store.readSpec(words[0]) ? words[0] : undefined;
      if (!name) {
        if (!open.length) return ctx.ui.notify(`No spec ready to build. Write one with /${cmd("spec")}.`, "warning");
        name = open.length === 1 || !ctx.hasUI ? open[0] : await ctx.ui.select("Build which spec?", open);
        if (!name) return;
      }
      const loaded = loadSpec(store, name);
      if (!loaded) return ctx.ui.notify(`${store.rel("specs", name, "spec.md")} doesn't parse. Rewrite it with /${cmd("spec")} ${name}.`, "error");
      const { spec, md } = loaded;
      const { testCmd, buildCmd } = commands(ctx.cwd, store);
      if (spec.gate === "tests" && !testCmd) return ctx.ui.notify(`Verification is "tests" but no test command is set: set "verify" in ${store.rel("config.json")}, or use Verification: build/none in the spec.`, "warning");
      if (spec.gate === "build" && !buildCmd) return ctx.ui.notify(`Verification is "build" but no build command is set: set "build" in ${store.rel("config.json")}.`, "warning");
      if (spec.dependsOn) {
        const dep = store.progress(spec.dependsOn)?.phase;
        if (dep !== "built" && dep !== "reviewed") {
          const go = ctx.hasUI && (await ctx.ui.confirm(`${name} depends on ${spec.dependsOn}`, `${spec.dependsOn} isn't built yet. Build ${name} anyway?`));
          if (!go) return;
        }
      }

      const prev = store.progress(name);
      const p: Progress = { spec: name, phase: "checking", baseCommit: gitHead(ctx.cwd), tasks: syncTasks(spec, prev?.tasks), updatedAt: now() };
      if (store.config().checkpoints) {
        dropCheckpoints(ctx.cwd);
        const snap = snapshot(ctx.cwd, `pb: start of ${name}`);
        store.saveCheckpoints(name, snap ? [{ id: "start", at: now(), ...snap, head: p.baseCommit, tasks: structuredClone(p.tasks) }] : []);
      }
      const seed = buildSeed(name, md, spec, testCmd, buildCmd);
      const parent = ctx.sessionManager.getSessionFile();
      const result = await ctx.newSession({
        parentSession: parent,
        withSession: async (c) => {
          p.session = c.sessionManager.getSessionFile();
          store.saveProgress(p);
          store.event(name!, { type: "build-start", tasks: spec.tasks.length, gate: spec.gate });
          pi.setActiveTools([...new Set([...pi.getActiveTools(), ...EDIT_TOOLS])]);
          await c.sendMessage({ customType: "pb", content: `▶ Building **${name}** from ${store.rel("specs", name!, "spec.md")}. First, a check of the spec against the code.`, display: true }, { triggerTurn: false });
          // Not awaited: the build runs on in this session, driven by agent_settled, while the command returns.
          void c.sendMessage({ customType: "pb-instruction", content: seed, display: false }, { triggerTurn: true });
        },
      });
      if (result.cancelled) ctx.ui.notify("Build cancelled.", "info");
    },
  });

  /* --------------------------------- undo -------------------------------- */

  pi.registerCommand(cmd("undo"), {
    description: "Restore the working tree and task list to before a task of this build, picked from a list",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) return ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
      const { store, name, progress: p } = specOfSession(ctx);
      if (!name || !p) return ctx.ui.notify(`Run /${cmd("undo")} in the build session of a spec.`, "warning");
      const cps = store.checkpoints(name);
      if (!cps.length) return ctx.ui.notify("No checkpoints for this build.", "info");
      const label = (c: Checkpoint) => (c.id === "start" ? `⌂ start of the build (${c.at})` : c.id.startsWith("u") ? `↺ before undo (${c.at})` : `${c.id}  ${c.summary ?? "(not finished)"}`);
      const newest = [...cps].reverse();
      const [idArg] = args.trim().split(/\s+/);
      let target = idArg ? cps.find((c) => c.id.toLowerCase() === idArg.toLowerCase()) : undefined;
      if (!target && ctx.hasUI && !idArg) {
        const labels = newest.map(label);
        const choice = await ctx.ui.select("Restore the working tree to the state BEFORE…", labels);
        target = choice ? newest[labels.indexOf(choice)] : undefined;
      }
      if (!target) return idArg ? ctx.ui.notify(`No checkpoint "${idArg}".`, "warning") : post(["```", ...newest.map((c) => `${c.id.padEnd(6)} ${label(c)}`), "```", `\`/${cmd("undo")} <id>\``].join("\n"));

      const cur = snapshot(ctx.cwd, "pb: before undo");
      if (!cur) return ctx.ui.notify("Could not snapshot the working tree (is this a git repository?). Nothing was changed.", "error");
      const files = changedPaths(ctx.cwd, cur.commit, target.commit);
      const idx = cps.indexOf(target);
      const undone = cps.slice(idx).filter((c) => c.task).map((c) => c.id);
      const head = gitHead(ctx.cwd);
      const summary = [
        `Files: ${files.length ? files.slice(0, 20).join(", ") + (files.length > 20 ? ` … (+${files.length - 20})` : "") : "none"}`,
        undone.length ? `Tasks back to todo: ${undone.join(", ")}` : "",
        target.head && head && target.head !== head ? "⚠ You committed since then: undo restores files but never moves your branch." : "",
      ]
        .filter(Boolean)
        .join("\n");
      if (ctx.hasUI && !(await ctx.ui.confirm(`Undo to before ${target.id === "start" ? "the build" : target.id}?`, summary))) return;
      restore(ctx.cwd, cur.commit, target.commit);
      const undoEntry: Checkpoint = { id: `u${cps.filter((c) => c.id.startsWith("u")).length + 1}`, at: now(), ...cur, head, tasks: structuredClone(p.tasks) };
      store.saveCheckpoints(name, [...cps.slice(0, idx).concat(target.id === "start" ? [target] : []), undoEntry]);
      p.tasks = structuredClone(target.tasks).filter((t) => t.id !== "final");
      p.current = undefined;
      p.report = undefined;
      p.phase = "paused";
      p.pause = `undone to before ${target.id}`;
      store.saveProgress(p);
      store.event(name, { type: "undo", to: target.id, tasks: undone });
      post(`**↺ Undone to before ${target.id === "start" ? "the build" : target.id}** — ${files.length} file(s) restored.\n${summary}\n\n${tip("undo.done", { id: undoEntry.id })}`);
    },
  });

  /* -------------------------------- status ------------------------------- */

  pi.registerCommand(cmd("status"), {
    description: "Every spec and where it stands",
    handler: async (_args, ctx) => {
      const store = new Store(ctx.cwd);
      const names = store.specNames();
      if (!names.length) return ctx.ui.notify(`No specs yet. Start with /${cmd("plan")} <feature>.`, "info");
      const here = store.specForSession(ctx.sessionManager.getSessionFile());
      const lines = names.flatMap((n) => {
        const p = store.progress(n);
        const s = loadSpec(store, n)?.spec;
        const head = `${n === here ? "▸ " : ""}${n} — ${p?.phase ?? "written"}${s ? ` · verification ${s.gate}${s.newTests ? "" : " · no new tests"}${s.dependsOn ? ` · depends on ${s.dependsOn}` : ""}` : " · ⚠ doesn't parse"}${p?.pause ? ` · paused: ${p.pause}` : ""}`;
        return [head, ...(p && p.phase !== "written" ? p.tasks.map((t) => `    ${taskLine(t)}`) : [])];
      });
      ctx.ui.notify([...lines, `help: /${cmd("help")}`].join("\n"), "info");
    },
  });

  /* --------------------------------- help -------------------------------- */

  pi.registerCommand(cmd("help"), {
    description: "What to do next and how to handle edge cases. /pb:help <topic> shows one section",
    handler: async (args, ctx) => {
      const name = args.trim().toLowerCase();
      const body = name ? topic(name) : undefined;
      if (body) return post(`${body}\n\n(Full guide: ${HELP_PATH})`);
      const list = topics().map((t) => `- \`/${cmd("help")} ${t.name}\` — ${t.title}`);
      if (!list.length) return ctx.ui.notify(`Help file not found: ${HELP_PATH}`, "warning");
      post([name ? `No help topic "${name}".` : "**pb help** — pick a topic:", "", ...list, "", `Full guide: ${HELP_PATH}`].join("\n"));
    },
  });
}
