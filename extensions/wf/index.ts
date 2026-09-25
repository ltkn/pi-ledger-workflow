/**
 * pi-ledger-workflow (wf) — ledger-based self-orchestration for Pi.
 *
 *   /wf:scope <feature>   investigate + explore        (main session, you discuss)
 *   /wf:plan [guidance]   decisions + plan + tasks     (main session, you approve)
 *   /wf:tests [T# | skip] acceptance tests from the spec (fresh context, you review)
 *   /wf:build [answer]    manager → worker → verify    (fresh contexts, automatic)
 *   /wf:review [focus]    independent review           (fresh context)
 *   /wf:status            where things stand
 *   /wf:stats [all]       numbers for this feature, or every feature by model
 *   /wf:undo [id]         restore the working tree to before a build round
 *   /wf:help [topic]      what to do next, and how to handle edge cases
 *
 * Based on the method of:
 *   V. Gao, V. Khosrowshahi, A. Khosrowshahi, X. Sun, J. Lee, E. Tran, S. (Sang Won) Lee.
 *   "GVS5H: Zero-Shot Self-Orchestration with Ledger-Based Control Improves Coding
 *   in Language Models." arXiv:2608.26480 (2026). https://arxiv.org/abs/2608.26480
 * This is an independent adaptation to interactive coding in Pi; see README.md
 * ("Credits" and "What's taken from the paper").
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type Flag, changedPaths, diffSummary, dropCheckpoints, inspectRound, restore, snapshot } from "./checkpoint.ts";
import {
  type Checkpoint,
  type Config,
  type Ledger as LedgerT,
  type Pause,
  type State,
  type Task,
  type WorkerReport,
  Ledger,
  PREFIX,
  cap,
  changedSinceBase,
  diffStat,
  fingerprint,
  gitHead,
  now,
} from "./ledger.ts";
import {
  REVIEWER_SYSTEM,
  SUMMARIZER_SYSTEM,
  TESTER_SYSTEM,
  managerBrief,
  managerSystem,
  planPrompt,
  reviewerBrief,
  scopePrompt,
  summarizerBrief,
  taskLine,
  testerBrief,
  workerBrief,
  workerSystem,
} from "./prompts.ts";
import { HELP_PATH, tip, topic, topics } from "./help.ts";
import { extractBlock, extractJson, runFresh, stripFence } from "./runner.ts";
import { type Spec, parkedFiles, readParked, removeParked, renderIndex, specState, syncSpecFiles, taskHash } from "./spec.ts";
import { loadAll, loadFeature, renderAll, renderCard } from "./stats.ts";
import { resolveVerify, runVerify } from "./verify.ts";

const cmd = (verb: string) => `${PREFIX}:${verb}`;
const READ_ONLY = ["read", "grep", "find", "ls"];

interface ManageDecision {
  tasks?: Partial<Task>[];
  next?: string | null;
  instruction?: string;
  done?: boolean;
  needs_input?: string | null;
  rationale?: string;
}

export default function wf(pi: ExtensionAPI) {
  /* ------------------------------- helpers ------------------------------- */

  /** A build or review is running (they span many turns; /wf:undo must not race them). */
  let busy = false;
  const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

  /** Visible message in the session; also enters the main agent's context so you can discuss it. */
  const post = (content: string) => pi.sendMessage({ customType: "wf", content, display: true }, { triggerTurn: false });

  /** Short visible marker + full instructions that start a main-session turn. */
  const instruct = (marker: string, prompt: string) => {
    post(marker);
    pi.sendMessage({ customType: "wf-instruction", content: prompt, display: false }, { triggerTurn: true });
  };

  /** Stats: record one fresh call. */
  const recordCall = (
    led: LedgerT,
    role: string,
    res: { cost: number; ms: number; turns: number; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; peakContext: number } },
    model: string | undefined,
    thinking: string | undefined,
    extra: { round?: number; task?: string; decided?: boolean } = {},
  ) =>
    led.event({ type: "call", at: now(), role, model, thinking, cost: res.cost, ms: res.ms, turns: res.turns, ...res.tokens, ...extra });

  const sessionModel = (ctx: ExtensionCommandContext) => (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
  const roleModel = (ctx: ExtensionCommandContext, cfg: Config, role: keyof Config["models"]) => cfg.models[role] ?? sessionModel(ctx);
  const roleThinking = (ctx: ExtensionCommandContext, cfg: Config, role: keyof Config["thinking"]) =>
    cfg.thinking[role] ?? (ctx.thinkingLevel as string | undefined);

  const newState = (feature: string, base?: string): State => ({
    phase: "scoped",
    feature,
    baseCommit: base,
    roundsTotal: 0,
    costTotal: 0,
    updatedAt: now(),
  });

  const requireScope = (ctx: ExtensionCommandContext, led: LedgerT): State | undefined => {
    const st = led.state();
    if (!st || !led.exists("objective.md")) {
      ctx.ui.notify(`No feature in progress. Start with /${cmd("scope")} <feature>`, "warning");
      return;
    }
    return st;
  };

  const requireIdle = (ctx: ExtensionCommandContext) => {
    if (ctx.isIdle()) return true;
    ctx.ui.notify("Pi is busy. Wait for the current turn to finish.", "warning");
    return false;
  };

  /* -------------------------------- scope -------------------------------- */

  pi.registerCommand(cmd("scope"), {
    description: "Start a feature: investigate the codebase and explore approaches (no code changes)",
    handler: async (args, ctx) => {
      const feature = args.trim();
      if (!feature) return ctx.ui.notify(`Usage: /${cmd("scope")} <feature description>`, "warning");
      if (!requireIdle(ctx)) return;
      const led = new Ledger(ctx.cwd);
      const prev = led.state();
      if (prev && led.exists("objective.md")) {
        const ok = ctx.hasUI
          ? await ctx.ui.confirm("Start a new feature?", `"${prev.feature}" is in progress (${prev.phase}). Its ledger will be archived.`)
          : true;
        if (!ok) return;
        const dest = led.archive();
        if (dest) ctx.ui.notify(`Archived previous ledger to ${dest}`, "info");
      }
      const cfg = led.config(); // writes defaults on first use
      dropCheckpoints(ctx.cwd);
      led.write("objective.md", `# Objective\n\n${feature}\n`);
      led.write("decisions.md", "# Decisions (binding for every worker)\n\n");
      led.saveState(newState(feature, gitHead(ctx.cwd)));
      const verify = resolveVerify(cfg.verify, ctx.cwd);
      if (!verify) ctx.ui.notify(`No verify command detected. Set "verify" in ${led.rel("config.json")} (e.g. "mvn -B -q test").`, "warning");
      instruct(`▶ /${cmd("scope")} — ${feature}`, scopePrompt(feature, verify));
    },
  });

  /* --------------------------------- plan -------------------------------- */

  pi.registerCommand(cmd("plan"), {
    description: "Write decisions, plan and task ledger from the scope and our discussion (re-run to revise)",
    handler: async (args, ctx) => {
      if (!requireIdle(ctx)) return;
      const led = new Ledger(ctx.cwd);
      const st = requireScope(ctx, led);
      if (!st) return;
      st.phase = "planned";
      st.pause = undefined;
      led.saveState(st);
      instruct(`▶ /${cmd("plan")}${args.trim() ? ` — ${args.trim()}` : ""}`, planPrompt(args.trim(), led.exists("tasks.json")));
    },
  });

  /* -------------------------------- build -------------------------------- */

  pi.registerCommand(cmd("build"), {
    description: "Run the manager → worker → verify loop in fresh contexts. Args answer a pending question or add guidance",
    handler: async (args, ctx) => {
      if (!requireIdle(ctx)) return;
      const led = new Ledger(ctx.cwd);
      const st = requireScope(ctx, led);
      if (!st) return;
      const loaded = led.tasks();
      if (!loaded.ok) return ctx.ui.notify(`${loaded.error}. Run /${cmd("plan")} first.`, "warning");
      let tasks = loaded.tasks;
      const cfg = led.config();
      const verifyCmd = resolveVerify(cfg.verify, ctx.cwd);

      // Spec tests: on whenever a verify command exists. Never skipped silently: ask once per feature.
      const specOn = cfg.specTests && !!verifyCmd;
      let spec = led.spec();
      const open = (t: Task) => t.status === "todo" || t.status === "doing";
      if (specOn && !spec && tasks.some(open)) {
        const WRITE = `Stop: I'll write them first with /${cmd("tests")}`;
        const WITHOUT = "Build without spec tests for this feature";
        const choice = ctx.hasUI ? await ctx.ui.select("This feature has no spec tests yet", [WRITE, WITHOUT]) : WITHOUT;
        if (choice !== WITHOUT) return post(tip("tests.missing"));
        const reason = ctx.hasUI ? ((await ctx.ui.input("Why build without spec tests? (optional, shown to the reviewer)", "")) ?? "").trim() : "";
        spec = { status: "skipped", reason: reason || "no reason given", tasks: {} };
        led.saveSpec(spec);
        led.recordDecision(`Build without spec tests${reason ? `: ${reason}` : ""}.`);
      } else if (specOn && spec?.status === "written") {
        const lacking = tasks.filter((t) => open(t) && ["missing", "stale"].includes(specState(spec, t))).map((t) => t.id);
        if (lacking.length) ctx.ui.notify(`No current spec tests for ${lacking.join(", ")}: /${cmd("tests")} adds them. Building anyway.`, "info");
      }
      const liveSpec = specOn && spec?.status === "written" ? spec : undefined;

      // A task paused on its attempt limit (and not since dropped/finished/reset by hand)
      // needs an answer like any question, and the answer buys it a fresh set of attempts.
      const exhausted =
        st.pause?.from === "harness" && st.pause.task && (st.pause.kind ?? "attempts") === "attempts"
          ? tasks.find(
              (t) => t.id === st.pause!.task && t.status !== "done" && t.status !== "dropped" && (t.attempts ?? 0) >= cfg.maxTaskAttempts,
            )
          : undefined;

      // Human input: answer to a pending question, or free guidance. Always persisted,
      // because fresh workers only ever see the ledger.
      const guidance = args.trim();
      if (guidance) {
        if (st.pause) led.recordDecision(`Q (${st.pause.from}${st.pause.task ? `, ${st.pause.task}` : ""}): ${st.pause.question}\nA: ${guidance}`);
        else led.recordDecision(`Guidance: ${guidance}`);
      } else if (st.pause && (st.pause.from !== "harness" || exhausted || st.pause.kind === "tampering")) {
        const answer = ctx.hasUI ? await ctx.ui.input("Answer the pending wf question", st.pause.question.slice(0, 200)) : undefined;
        if (!answer?.trim()) {
          post(`**Build is waiting for a decision**\n\n${st.pause.question}\n\nAnswer with \`/${cmd("build")} <answer>\`, or discuss here first.`);
          return;
        }
        led.recordDecision(`Q (${st.pause.from}${st.pause.task ? `, ${st.pause.task}` : ""}): ${st.pause.question}\nA: ${answer.trim()}`);
      }
      if (exhausted) {
        exhausted.attempts = 0;
        led.saveTasks(tasks);
      }
      if (st.pause?.kind === "tampering" && st.pause.task && st.tamper) st.tamper[st.pause.task] = 0;
      st.pause = undefined;
      st.phase = "building";
      led.saveState(st);

      const abort = new AbortController();
      const unsubEsc =
        ctx.mode === "tui"
          ? ctx.ui.onTerminalInput((d) => {
              if (d === "\x1b") {
                abort.abort();
                return { consume: true };
              }
              return undefined;
            })
          : undefined;

      let activity = "";
      const render = (round: number, phase: string) => {
        ctx.ui.setStatus("wf", `wf ${round}/${cfg.maxRounds} · ${phase}`);
        const lines = [`wf build — round ${round}/${cfg.maxRounds} · ${phase}   (Esc to stop)`, ...tasks.map(taskLine)];
        if (activity) lines.push(`  ↳ ${activity}`);
        ctx.ui.setWidget("wf", lines);
      };

      const runCost = { total: 0 };
      const addCost = (c: number) => {
        runCost.total += c;
        st.costTotal += c;
      };
      const assumptionsThisRun: string[] = [];
      let outcome: "done" | "paused" | "budget" | "stalled" | "aborted" | "error" = "budget";
      let outcomeNote = "";
      let lastPicked: string | undefined = st.lastReport?.task;
      let lastRoundChanged = true;

      /** Ask inline if possible; otherwise (or if skipped) pause back to the conversation. */
      const askHuman = async (question: string, from: Pause["from"], task?: string, kind?: Pause["kind"]): Promise<boolean> => {
        post(`**wf needs a decision** (${from}${task ? `, ${task}` : ""})\n\n${question}`);
        const a = ctx.hasUI ? await ctx.ui.input("Answer now (empty = pause and discuss)", "") : undefined;
        led.event({ type: "question", at: now(), from, kind, task, answered: !!a?.trim() });
        if (a?.trim()) {
          led.recordDecision(`Q (${from}${task ? `, ${task}` : ""}): ${question}\nA: ${a.trim()}`);
          return true;
        }
        st.pause = { question, from, task, kind };
        return false;
      };

      // Checkpoints: a start-of-build anchor, then a snapshot before and after every worker round.
      let cps: Checkpoint[] = cfg.checkpoints ? led.checkpoints() : [];
      let start = cps.find((c) => c.id === "start");
      if (cfg.checkpoints && !start) {
        const snap = snapshot(ctx.cwd, "wf: start of build");
        if (snap) {
          start = { id: "start", at: now(), ...snap, head: gitHead(ctx.cwd), tasks: clone(tasks), notes: led.read("notes.md") };
          cps.push(start);
          led.saveCheckpoints(cps);
        }
      }
      const flagsThisRun: string[] = [];

      const firstUnfinished = () => tasks.find((t) => t.status === "doing") ?? tasks.find((t) => t.status === "todo");

      const ensureFixTask = (): Task => {
        let fix = tasks.find((t) => t.source === "verify" && t.status !== "done" && t.status !== "dropped");
        if (!fix) {
          fix = {
            id: `F${tasks.filter((t) => t.source === "verify").length + 1}`,
            title: "Make verification pass",
            detail: st.lastVerify?.summary ?? "",
            status: "todo",
            attempts: 0,
            source: "verify",
          };
          tasks.push(fix);
        }
        return fix;
      };

      /** Accept "done" only with no open tasks, real changes on disk, and a fresh passing verification. */
      const tryFinish = async (round: number): Promise<boolean> => {
        if (firstUnfinished()) return false;
        const changed = changedSinceBase(ctx.cwd, st.baseCommit);
        if (changed && changed.length === 0) return false;
        if (verifyCmd) {
          const fp = fingerprint(ctx.cwd);
          if (!st.lastVerify || st.lastVerify.command !== verifyCmd || fp === undefined || st.lastVerify.fingerprint !== fp) {
            activity = verifyCmd;
            render(round, "final verify");
            st.lastVerify = { ...(await runVerify(verifyCmd, ctx.cwd, cfg.verifyTimeoutSec, cfg.caps.verifyOutput, abort.signal)), fingerprint: fp };
            led.saveState(st);
          }
        }
        return st.lastVerify?.ok !== false;
      };

      /** The manager sends only changed or new tasks: patch those in place, append new ones, keep the rest as is. */
      const mergeTasks = (proposed: Partial<Task>[] | undefined) => {
        if (!Array.isArray(proposed) || !proposed.length) return;
        const patches = new Map(proposed.filter((p) => p?.id).map((p) => [String(p.id), p]));
        const apply = (old: Task | undefined, p: Partial<Task>): Task => {
          const status = (["todo", "doing", "done", "dropped"].includes(p.status as string) ? p.status : old?.status ?? "todo") as Task["status"];
          return {
            id: String(p.id),
            title: p.title ?? old?.title ?? String(p.id),
            detail: p.detail ?? old?.detail,
            acceptance: p.acceptance ?? old?.acceptance,
            // The manager may only mark done a task a worker actually attempted, and never while
            // verification is failing (paper: verifier is ground truth; no finishing on an empty workspace).
            status:
              status === "done" &&
              old?.status !== "done" &&
              (!(old?.attempts ?? 0) || st.lastVerify?.ok === false || (st.lastRound?.task === old?.id && !!st.lastRound?.flags.length))
                ? (old?.status ?? "todo")
                : status,
            attempts: old?.attempts ?? 0,
            source: old?.source ?? "manager",
          };
        };
        const merged = tasks.map((t) => {
          const p = patches.get(t.id);
          return p ? apply(t, p) : t;
        });
        for (const [id, p] of patches) if (!tasks.some((t) => t.id === id)) merged.push(apply(undefined, p));
        tasks = merged;
      };

      busy = true;
      try {
        for (let round = 1; round <= cfg.maxRounds; round++) {
          if (abort.signal.aborted) {
            outcome = "aborted";
            break;
          }
          st.roundsTotal++;
          const roundTasks = clone(tasks);
          const roundNotes = led.read("notes.md");

          /* ---- MANAGE (fresh context, read-only) ---- */
          activity = "";
          render(round, "manager");
          const mres = await runFresh({
            cwd: ctx.cwd,
            role: "manager",
            systemPrompt: managerSystem(cfg),
            brief: managerBrief(led, cfg, st, tasks, round, cfg.maxRounds, specOn ? spec : undefined),
            prompt: "Carry out the brief in the attached file. End with the wf-manage block.",
            tools: READ_ONLY,
            model: roleModel(ctx, cfg, "manager"),
            thinking: roleThinking(ctx, cfg, "manager"),
            childExtensions: cfg.childExtensions,
            signal: abort.signal,
            onActivity: (a) => {
              activity = `manager: ${a}`;
              render(round, "manager");
            },
          });
          addCost(mres.cost);
          if (mres.aborted) {
            outcome = "aborted";
            break;
          }
          const dec = extractJson<ManageDecision>(mres.text, "wf-manage");
          recordCall(led, "manager", mres, roleModel(ctx, cfg, "manager"), roleThinking(ctx, cfg, "manager"), { round: st.roundsTotal, decided: !!dec });
          if (!dec) {
            // Paper: "none named → first unfinished task".
            led.append("log.md", `\n### Round ${st.roundsTotal} (${now()}) — manager produced no decision${mres.error ? `: ${cap(mres.error, 300)}` : ""}; falling back to first unfinished task\n`);
          } else {
            mergeTasks(dec.tasks);
          }
          led.saveTasks(tasks);

          if (dec?.needs_input && cfg.questions === "ask") {
            if (!(await askHuman(dec.needs_input, "manager"))) {
              outcome = "paused";
              break;
            }
            continue; // re-manage with the new decision on the ledger
          }

          let next: Task | undefined = dec?.next ? tasks.find((t) => t.id === dec.next) : undefined;
          if (next && (next.status === "done" || next.status === "dropped")) next = undefined;

          if (!next && (dec?.done || !firstUnfinished())) {
            if (await tryFinish(round)) {
              outcome = "done";
              break;
            }
            if (abort.signal.aborted) {
              outcome = "aborted";
              break;
            }
            if (st.lastVerify?.ok !== false && !firstUnfinished()) {
              outcome = "stalled";
              outcomeNote = "every task is marked done but nothing changed on disk.";
              break;
            }
            const vetoReason = st.lastVerify?.ok === false ? "verification failing" : "unfinished tasks";
            led.append("log.md", `\n### Round ${st.roundsTotal} — finish vetoed (${vetoReason})\n`);
            led.event({ type: "veto", at: now(), round: st.roundsTotal, reason: vetoReason });
          }
          if (!next) next = st.lastVerify?.ok === false ? ensureFixTask() : firstUnfinished();
          if (!next) {
            outcome = "done";
            break;
          }

          // No-progress guard (paper: reissuing the task just handed out stops the loop).
          if (next.id === lastPicked && !lastRoundChanged) {
            outcome = "stalled";
            outcomeNote = `${next.id} was reissued after a round that changed nothing.`;
            break;
          }
          next.attempts = (next.attempts ?? 0) + 1;
          if (next.attempts > cfg.maxTaskAttempts) {
            next.attempts--;
            const q = `${next.id} "${next.title}" has taken ${cfg.maxTaskAttempts} rounds without completing.\nLast report: ${st.lastReport?.summary ?? "(none)"}\nLast verification: ${st.lastVerify?.summary.split("\n")[0] ?? "(none)"}\n\nHow should it proceed? (e.g. a hint, a different approach, drop or split the task)`;
            if (!(await askHuman(q, "harness", next.id, "attempts"))) {
              outcome = "paused";
              break;
            }
            next.attempts = 0;
            continue;
          }
          next.status = "doing";
          led.saveTasks(tasks);

          /* ---- WORK (fresh context, full tools) ---- */
          const fpBefore = fingerprint(ctx.cwd);
          const n = st.roundsTotal;
          // Spec tests of this task and of finished tasks are in place for the round, and restored after it.
          const specIds = liveSpec ? tasks.filter((t) => t.id === next!.id || t.status === "done").map((t) => t.id).filter((id) => liveSpec.tasks[id]?.files.length) : [];
          const syncSpecs = () => specIds.flatMap((id) => syncSpecFiles(ctx.cwd, id, liveSpec!.tasks[id].files));
          syncSpecs();
          const pre = start ? snapshot(ctx.cwd, `wf: before round ${n} (${next.id})`) : undefined;
          let entry: Checkpoint | undefined;
          if (pre) {
            entry = { id: `r${n}`, at: now(), ...pre, head: gitHead(ctx.cwd), tasks: roundTasks, notes: roundNotes, task: next.id };
            cps.push(entry);
            led.saveCheckpoints(cps);
          }
          activity = "";
          render(round, `worker ${next.id}`);
          const wres = await runFresh({
            cwd: ctx.cwd,
            role: "worker",
            systemPrompt: workerSystem(cfg),
            brief: workerBrief(led, cfg, st, next, dec?.instruction ?? "", verifyCmd, liveSpec),
            prompt: `Carry out the brief in the attached file: do only task ${next.id}. End with the wf-notes and wf-report blocks.`,
            tools: cfg.workerTools,
            model: roleModel(ctx, cfg, "worker"),
            thinking: roleThinking(ctx, cfg, "worker"),
            childExtensions: cfg.childExtensions,
            signal: abort.signal,
            onActivity: (a) => {
              activity = `worker: ${a}`;
              render(round, `worker ${next!.id}`);
            },
          });
          addCost(wres.cost);
          if (wres.aborted) {
            outcome = "aborted";
            break;
          }

          recordCall(led, "worker", wres, roleModel(ctx, cfg, "worker"), roleThinking(ctx, cfg, "worker"), { round: n, task: next.id });
          let reportSource: "ok" | "salvaged" | "lost" = "ok";
          let report = extractJson<WorkerReport>(wres.text, "wf-report");
          let notes = extractBlock(wres.text, "wf-notes") ?? report?.notes;
          if (!report) {
            // Cut-off summarizer: salvage the attempt so its ideas reach the manager.
            render(round, `summarising ${next.id}`);
            const sres = await runFresh({
              cwd: ctx.cwd,
              role: "summarizer",
              systemPrompt: SUMMARIZER_SYSTEM,
              brief: summarizerBrief(led, cfg, next, wres.transcript || wres.error || "(no output)"),
            prompt: "Summarise the attempt in the attached file. Output only the wf-notes and wf-report blocks.",
              tools: null,
              model: roleModel(ctx, cfg, "worker"),
              thinking: "low",
              childExtensions: false,
              signal: abort.signal,
            });
            addCost(sres.cost);
            recordCall(led, "summarizer", sres, roleModel(ctx, cfg, "worker"), "low", { round: n, task: next.id });
            const salvaged = extractJson<WorkerReport>(sres.text, "wf-report");
            reportSource = salvaged ? "salvaged" : "lost";
            // The summarizer never sees tool results, so it can't know the task is complete.
            report = salvaged
              ? { ...salvaged, status: "partial" }
              : {
                  status: "partial",
                  summary: `Worker ended without a report (${wres.stopReason ?? "unknown"}${wres.error ? `: ${cap(wres.error, 200)}` : ""}).`,
                };
            notes = extractBlock(sres.text, "wf-notes") ?? salvaged?.notes ?? notes;
          }
          if (notes?.trim()) led.write("notes.md", cap(notes.trim(), cfg.caps.notes) + "\n");

          /* ---- INSPECT (harness): what the round really changed, and anything it broke ---- */
          const notices: string[] = [];
          const edited = syncSpecs();
          if (edited.length) notices.push(`spec tests edited or removed by the worker, restored: ${edited.join(", ")}`);
          let post = pre ? snapshot(ctx.cwd, `wf: after round ${n} (${next.id})`) : undefined;
          let flags: Flag[] = [];
          let pauseAfter: Pause | undefined;
          if (pre && post && start) {
            const others = new Set(cps.filter((c) => c.task && c.task !== next!.id).flatMap((c) => c.files ?? []));
            flags = inspectRound(ctx.cwd, pre, post, start, others);
            const lost = flags.find((f) => f.kind === "lost-work");
            if (lost) {
              render(round, "lost work?");
              const restoreIt =
                ctx.hasUI &&
                (await ctx.ui.confirm(
                  `Round ${n} (${next.id}) reverted earlier work`,
                  `${lost.files.join("\n")}\n\nRestore these files to how they were before the round? The rest of the round's changes stay.`,
                ));
              if (restoreIt) {
                restore(ctx.cwd, post.commit, pre.commit, lost.files);
                post = snapshot(ctx.cwd, `wf: after round ${n} (${next.id}), lost work restored`) ?? post;
                lost.detail += " (restored by the human)";
                led.recordDecision(`Round ${n} (${next.id}) reverted earlier tasks' work in ${lost.files.join(", ")}; the human restored it. Never discard other tasks' changes.`);
              } else {
                pauseAfter = {
                  from: "harness",
                  task: next.id,
                  kind: "lost-work",
                  question: `Round ${n} (${next.id}) ${lost.detail}.\nUndo it with /${cmd("undo")} (pick r${n} to drop the whole round), or keep it and continue with /${cmd("build")} <guidance>.`,
                };
              }
            }
          }
          const tamper = flags.find((f) => f.kind === "tampering");
          if (tamper) st.tamper = { ...st.tamper, [next.id]: (st.tamper?.[next.id] ?? 0) + 1 };
          flagsThisRun.push(...flags.map((f) => `r${n} ${next!.id} ${f.kind}: ${f.detail}`));

          const fpAfter = fingerprint(ctx.cwd);
          lastRoundChanged = pre && post ? pre.tree !== post.tree : fpAfter === undefined || fpAfter !== fpBefore;

          /* ---- VERIFY (harness, ground truth) ---- */
          if (verifyCmd && (lastRoundChanged || !st.lastVerify || st.lastVerify.fingerprint !== fpAfter)) {
            activity = verifyCmd;
            render(round, "verify");
            st.lastVerify = await runVerify(verifyCmd, ctx.cwd, cfg.verifyTimeoutSec, cfg.caps.verifyOutput, abort.signal);
            st.lastVerify.fingerprint = fpAfter;
            if (abort.signal.aborted) {
              outcome = "aborted";
              break;
            }
          } else if (!verifyCmd) {
            st.lastVerify = { ok: null, command: null, summary: "No verify command configured.", at: now() };
          }

          const roundStats: { files?: number; added?: number; removed?: number } = {};
          // A flagged round can't complete its task, whatever the report says.
          if (report.status === "done" && st.lastVerify?.ok !== false && !flags.length) next.status = "done";
          st.lastReport = { ...report, task: next.id, changed: lastRoundChanged };
          if (pre && post && entry) {
            const d = diffSummary(ctx.cwd, pre.commit, post.commit, 3000);
            const flagLines = flags.map((f) => `${f.kind}: ${f.detail}`);
            st.lastRound = { round: n, task: next.id, stat: d.stat, patch: d.patch, flags: flagLines, notices };
            entry.files = changedPaths(ctx.cwd, pre.commit, post.commit);
            const v = st.lastVerify?.ok === true ? "✓" : st.lastVerify?.ok === false ? "✗" : "–";
            entry.summary = `${next.id} ${report.status} · ${d.files} files +${d.added} −${d.removed} · verify ${v}${flags.length ? " · ⚑ " + flags.map((f) => f.kind).join(", ") : ""} · ${cap(report.summary.replace(/\s+/g, " "), 60)}`;
            led.saveCheckpoints(cps);
            Object.assign(roundStats, { files: d.files, added: d.added, removed: d.removed });
          } else st.lastRound = undefined;
          led.event({
            type: "round",
            at: now(),
            round: n,
            task: next.id,
            attempt: next.attempts ?? 1,
            status: report.status,
            report: reportSource,
            verify: st.lastVerify?.ok ?? null,
            changed: lastRoundChanged,
            ...roundStats,
            flags: flags.map((f) => `${f.kind}: ${f.detail}`),
            notices,
            taskDone: next.status === "done",
          });
          lastPicked = next.id;
          led.saveTasks(tasks);

          const assumptions = (report.assumptions ?? []).filter((a) => a?.trim());
          if (assumptions.length) {
            assumptionsThisRun.push(...assumptions.map((a) => `${next!.id}: ${a}`));
            led.append("assumptions.md", assumptions.map((a) => `- ${next!.id}: ${a}\n`).join(""));
          }
          led.append(
            "log.md",
            `\n### Round ${st.roundsTotal} (${now()}) — ${next.id} ${next.title}\n` +
              `Manager: ${dec?.rationale ?? "(fallback)"}\n` +
              `Worker: ${report.status} — ${report.summary}\n` +
              (assumptions.length ? `Assumptions: ${assumptions.join("; ")}\n` : "") +
              (flags.length ? `Harness flags: ${flags.map((f) => `${f.kind}: ${f.detail}`).join("; ")}\n` : "") +
              (notices.length ? `Notices: ${notices.join("; ")}\n` : "") +
              `Verify: ${st.lastVerify?.summary.split("\n")[0] ?? "-"}\n` +
              `Changed files this round: ${lastRoundChanged ? "yes" : "no"} · cost $${(mres.cost + wres.cost).toFixed(4)}\n`,
          );
          led.saveState(st);

          if (pauseAfter) {
            st.pause = pauseAfter;
            outcome = "paused";
            break;
          }
          if (tamper && (st.tamper?.[next.id] ?? 0) >= 2) {
            const q = `${next.id}'s worker changed existing tests again: ${tamper.detail}\n\nHow should it proceed? (e.g. "the tests are right, fix the code", or allow one specific test change and say why)`;
            if (!(await askHuman(q, "harness", next.id, "tampering"))) {
              outcome = "paused";
              break;
            }
            st.tamper![next.id] = 0;
          }
          if (report.status === "needs_input" && report.question && cfg.questions === "ask") {
            if (!(await askHuman(report.question, "worker", next.id))) {
              outcome = "paused";
              break;
            }
          }
        }
      } catch (e) {
        outcome = "error";
        outcomeNote = (e as Error).message;
      } finally {
        busy = false;
        unsubEsc?.();
        ctx.ui.setWidget("wf", undefined);
        ctx.ui.setStatus("wf", undefined);
      }

      led.event({ type: "build-end", at: now(), outcome });

      /* ---- wrap up: harness-written handoff (the paper's finalizer role, without a model call) ---- */
      if (outcome === "stalled") st.pause = { question: `Build stalled: ${outcomeNote}\nLast report: ${st.lastReport?.summary ?? ""}`, from: "harness" };
      st.phase = outcome === "done" ? "built" : outcome === "paused" || outcome === "stalled" ? "paused" : "building";
      led.saveTasks(tasks);
      led.saveState(st);

      const headline: Record<typeof outcome, string> = {
        done: "✅ BUILD COMPLETE — all tasks done",
        paused: "⏸ BUILD PAUSED — waiting for your decision",
        budget: `⏹ BUILD STOPPED — round budget (${cfg.maxRounds}) reached`,
        stalled: "⏹ BUILD STALLED — no progress",
        aborted: "⏹ BUILD STOPPED — by you",
        error: "⚠ BUILD ERROR",
      };
      const pauseTip = { attempts: "paused-attempts", "lost-work": "paused-lost-work", tampering: "paused-tampering" } as const;
      const tipKey =
        outcome === "paused"
          ? st.pause?.from === "harness" && st.pause.task
            ? pauseTip[st.pause.kind ?? "attempts"]
            : "paused-question"
          : outcome;
      const whatNow = tip(`build.${tipKey}`, { task: st.pause?.task ?? "", max: cfg.maxTaskAttempts, rounds: cfg.maxRounds, round: st.lastRound?.round ?? "" });
      post(
        [
          `**${headline[outcome]}**${outcomeNote ? ` — ${outcomeNote}` : ""}`,
          "",
          "```",
          ...tasks.map(taskLine),
          "```",
          `Verification: ${st.lastVerify?.summary.split("\n")[0] ?? "not run"}`,
          assumptionsThisRun.length ? `\nAssumptions made (review these):\n${assumptionsThisRun.map((a) => `- ${a}`).join("\n")}` : "",
          flagsThisRun.length ? `\n⚑ Harness flags (a flagged round can't complete its task):\n${flagsThisRun.map((f) => `- ${f}`).join("\n")}` : "",
          st.pause && outcome !== "stalled" ? `\nOpen question: ${st.pause.question}` : "",
          `\nThis run: $${runCost.total.toFixed(3)} · feature total: ${st.roundsTotal} rounds, $${st.costTotal.toFixed(3)}`,
          `\n${whatNow}`,
          "",
          `(Note for the assistant: build workers only read ${led.rel("")}. If the user decides something while discussing this, write it to ${led.rel("decisions.md")}. For how to handle this situation, see ${HELP_PATH}.)`,
        ]
          .filter((l) => l !== "")
          .join("\n"),
      );
    },
  });

  /* -------------------------------- review ------------------------------- */

  pi.registerCommand(cmd("review"), {
    description: "Independent fresh-context review of the change against objective, plan and decisions",
    handler: async (args, ctx) => {
      if (!requireIdle(ctx)) return;
      const led = new Ledger(ctx.cwd);
      const st = requireScope(ctx, led);
      if (!st) return;
      const cfg = led.config();
      const loaded = led.tasks();
      const tasks = loaded.ok ? loaded.tasks : [];

      const abort = new AbortController();
      const unsubEsc =
        ctx.mode === "tui"
          ? ctx.ui.onTerminalInput((d) => (d === "\x1b" ? (abort.abort(), { consume: true }) : undefined))
          : undefined;
      busy = true;
      try {
        // Refresh ground truth if the tree changed since the last verification.
        const verifyCmd = resolveVerify(cfg.verify, ctx.cwd);
        const fp = fingerprint(ctx.cwd);
        if (verifyCmd && (!st.lastVerify || st.lastVerify.fingerprint !== fp)) {
          ctx.ui.setWidget("wf", [`wf review — running ${verifyCmd}   (Esc to stop)`]);
          st.lastVerify = { ...(await runVerify(verifyCmd, ctx.cwd, cfg.verifyTimeoutSec, cfg.caps.verifyOutput, abort.signal)), fingerprint: fp };
        }
        let activity = "";
        const render = () => ctx.ui.setWidget("wf", [`wf review — fresh reviewer   (Esc to stop)`, ...(activity ? [`  ↳ ${activity}`] : [])]);
        render();
        const res = await runFresh({
          cwd: ctx.cwd,
          role: "reviewer",
          systemPrompt: REVIEWER_SYSTEM,
          prompt: "Review the change described in the attached file. End with the wf-review block.",
          brief: reviewerBrief(led, st, tasks, changedSinceBase(ctx.cwd, st.baseCommit), diffStat(ctx.cwd, st.baseCommit), args.trim(), led.spec()),
          tools: [...READ_ONLY, "bash"],
          model: roleModel(ctx, cfg, "reviewer"),
          thinking: roleThinking(ctx, cfg, "reviewer"),
          childExtensions: cfg.childExtensions,
          signal: abort.signal,
          onActivity: (a) => {
            activity = a;
            render();
          },
        });
        recordCall(led, "reviewer", res, roleModel(ctx, cfg, "reviewer"), roleThinking(ctx, cfg, "reviewer"));
        if (res.aborted) return ctx.ui.notify("Review stopped.", "info");
        if (!res.text.trim()) return ctx.ui.notify(`Reviewer produced no output${res.error ? `: ${cap(res.error, 300)}` : ""}`, "error");

        const verdict = extractJson<{ verdict?: string; followups?: Partial<Task>[] }>(res.text, "wf-review");
        const prose = stripFence(res.text, "wf-review");
        led.write("review.md", `# Review (${now()})\n\n${prose}\n`);
        st.costTotal += res.cost;

        const added: Task[] = [];
        if (verdict?.verdict === "changes_needed" && verdict.followups?.length && loaded.ok) {
          const n = tasks.filter((t) => t.source === "review").length;
          verdict.followups.forEach((f, i) => {
            if (!f?.title) return;
            added.push({ id: `R${n + i + 1}`, title: f.title, detail: f.detail, acceptance: f.acceptance, status: "todo", attempts: 0, source: "review" });
          });
          led.saveTasks([...tasks, ...added]);
        }
        led.event({ type: "review", at: now(), verdict: verdict?.verdict ?? "none", followups: added.length });
        st.phase = added.length ? "planned" : "reviewed";
        led.saveState(st);

        post(
          [
            prose,
            "",
            added.length
              ? `**Added ${added.map((t) => t.id).join(", ")} to the task ledger.**\n\n${tip("review.followups", { tasks: added.map((t) => t.id).join(", ") })}`
              : verdict?.verdict === "pass"
                ? `**REVIEW PASS.**\n\n${tip("review.pass")}`
                : tip("review.other"),
          ].join("\n"),
        );
      } finally {
        busy = false;
        unsubEsc?.();
        ctx.ui.setWidget("wf", undefined);
      }
    },
  });

  /* -------------------------------- status ------------------------------- */

  pi.registerCommand(cmd("status"), {
    description: "Show the current feature, phase, tasks, verification and any pending question",
    handler: async (_args, ctx) => {
      const led = new Ledger(ctx.cwd);
      const st = requireScope(ctx, led);
      if (!st) return;
      const cfg = led.config();
      const loaded = led.tasks();
      const phaseNext: Record<State["phase"], string> = {
        scoped: `/${cmd("plan")}`,
        planned: `/${cmd("build")}`,
        building: `/${cmd("build")} (continue) or /${cmd("review")}`,
        paused: `/${cmd("build")} <answer>`,
        built: `/${cmd("review")}`,
        reviewed: "commit / PR",
      };
      const lines = [
        `wf — ${st.feature}`,
        `phase: ${st.phase} · rounds: ${st.roundsTotal} · cost: $${st.costTotal.toFixed(3)} · questions: ${cfg.questions}`,
        `verify: ${resolveVerify(cfg.verify, ctx.cwd) ?? "(none)"} → ${st.lastVerify ? (st.lastVerify.ok === null ? "n/a" : st.lastVerify.ok ? "PASS" : "FAIL") : "not run"}`,
        ...(loaded.ok ? loaded.tasks.map(taskLine) : [`tasks: ${loaded.error}`]),
        ...(st.pause ? [`pending: ${st.pause.question.split("\n")[0]}`] : []),
        ...(() => {
          const sp = led.spec();
          if (!cfg.specTests || !resolveVerify(cfg.verify, ctx.cwd)) return [];
          if (!sp) return [`spec tests: not written yet (/${cmd("tests")})`];
          if (sp.status === "skipped") return [`spec tests: skipped (${sp.reason})`];
          const ts = loaded.ok ? loaded.tasks.filter((t) => t.status !== "dropped") : [];
          const by = (k: string) => ts.filter((t) => specState(sp, t) === k).map((t) => t.id);
          const parts = [`${by("ok").length} task(s) covered`, ...(["skipped", "stale", "missing"] as const).filter((k) => by(k).length).map((k) => `${k}: ${by(k).join(", ")}`)];
          return [`spec tests: ${parts.join(" · ")}`];
        })(),
        ...(led.checkpoints().some((c) => c.task) ? [`checkpoints: ${led.checkpoints().filter((c) => c.task).length} rounds · /${cmd("undo")} to go back`] : []),
        `next: ${phaseNext[st.phase]}`,
        `ledger: ${led.rel("")} · help: /${cmd("help")}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  /* -------------------------------- tests -------------------------------- */

  pi.registerCommand(cmd("tests"), {
    description: "Write acceptance tests from the spec before the build (fresh tester, you review). /wf:tests T3 <change> · /wf:tests skip [T2] <why>",
    handler: async (args, ctx) => {
      if (busy || !requireIdle(ctx)) return busy ? ctx.ui.notify("A build or review is running. Stop it first (Esc).", "warning") : undefined;
      const led = new Ledger(ctx.cwd);
      const st = requireScope(ctx, led);
      if (!st) return;
      const loaded = led.tasks();
      if (!loaded.ok) return ctx.ui.notify(`${loaded.error}. Run /${cmd("plan")} first.`, "warning");
      const tasks = loaded.tasks;
      const cfg = led.config();
      if (!resolveVerify(cfg.verify, ctx.cwd)) return ctx.ui.notify(`Spec tests need a verify command: set "verify" in ${led.rel("config.json")}.`, "warning");
      const spec: Spec = led.spec()?.status === "written" ? led.spec()! : { status: "written", tasks: {} };
      const isTask = (w?: string) => !!w && tasks.some((t) => t.id.toLowerCase() === w.toLowerCase());
      const byId = (w: string) => tasks.find((t) => t.id.toLowerCase() === w.toLowerCase())!;
      const words = args.trim().split(/\s+/).filter(Boolean);
      const saveIndex = () => {
        led.saveSpec(spec);
        led.write("spec/index.md", renderIndex(spec, tasks));
      };

      // Skipping: the whole feature, or one task.
      if (words[0]?.toLowerCase() === "skip") {
        if (isTask(words[1])) {
          const t = byId(words[1]);
          const why = words.slice(2).join(" ") || "skipped by the human";
          removeParked(ctx.cwd, t.id);
          spec.tasks[t.id] = { files: [], tests: [], skip: why, hash: taskHash(t), at: now() };
          saveIndex();
          led.recordDecision(`No spec tests for ${t.id}: ${why}.`);
          return post(`**${t.id} will be built without spec tests** (${why}).\n\n${tip("tests.done")}`);
        }
        const why = words.slice(1).join(" ") || "no reason given";
        led.saveSpec({ status: "skipped", reason: why, tasks: {} });
        led.recordDecision(`Build without spec tests: ${why}.`);
        return post(`**This feature will be built without spec tests** (${why}). Workers write their own tests; the reviewer is told.\n\nNext: \`/${cmd("build")}\``);
      }

      // Which tasks: one named task (always rewritten), or every open task without current tests.
      let targets: Task[];
      let guidance = args.trim();
      if (isTask(words[0])) {
        targets = [byId(words[0])];
        guidance = words.slice(1).join(" ");
      } else {
        targets = tasks.filter((t) => t.status !== "done" && t.status !== "dropped" && ["missing", "stale"].includes(specState(spec, t)));
      }
      if (!targets.length) return ctx.ui.notify(`Every open task already has current spec tests (or is skipped). /${cmd("tests")} <task> <change> rewrites one.`, "info");
      if (guidance) led.recordDecision(`Spec tests (${targets.map((t) => t.id).join(", ")}): ${guidance}`);

      const previous: Record<string, { rel: string; content: string }[]> = {};
      for (const t of targets) {
        previous[t.id] = parkedFiles(ctx.cwd, t.id).map((rel) => ({ rel, content: readParked(ctx.cwd, t.id, rel) }));
        removeParked(ctx.cwd, t.id);
      }

      const abort = new AbortController();
      const unsubEsc =
        ctx.mode === "tui" ? ctx.ui.onTerminalInput((d) => (d === "\x1b" ? (abort.abort(), { consume: true }) : undefined)) : undefined;
      let activity = "";
      const render = () =>
        ctx.ui.setWidget("wf", [`wf tests — writing spec tests for ${targets.map((t) => t.id).join(", ")}   (Esc to stop)`, ...(activity ? [`  ↳ ${activity}`] : [])]);
      const pre = cfg.checkpoints ? snapshot(ctx.cwd, "wf: before tester") : undefined;
      busy = true;
      let res;
      try {
        render();
        res = await runFresh({
          cwd: ctx.cwd,
          role: "tester",
          systemPrompt: TESTER_SYSTEM,
          brief: testerBrief(led, cfg, tasks, targets, guidance, previous),
          prompt: `Carry out the brief in the attached file: write spec tests for ${targets.map((t) => t.id).join(", ")}. End with the wf-tests block.`,
          tools: [...READ_ONLY, "write"],
          model: roleModel(ctx, cfg, "tester"),
          thinking: roleThinking(ctx, cfg, "tester"),
          childExtensions: cfg.childExtensions,
          signal: abort.signal,
          onActivity: (a) => {
            activity = a;
            render();
          },
        });
      } finally {
        busy = false;
        unsubEsc?.();
        ctx.ui.setWidget("wf", undefined);
      }
      st.costTotal += res.cost;
      led.saveState(st);
      recordCall(led, "tester", res, roleModel(ctx, cfg, "tester"), roleThinking(ctx, cfg, "tester"));

      // The tester may only write parked files: undo anything it wrote in the repo itself.
      const problems: string[] = [];
      const post2 = pre ? snapshot(ctx.cwd, "wf: after tester") : undefined;
      if (pre && post2 && pre.tree !== post2.tree) {
        const stray = changedPaths(ctx.cwd, pre.commit, post2.commit);
        restore(ctx.cwd, post2.commit, pre.commit, stray);
        problems.push(`The tester wrote outside ${led.rel("spec")} (reverted): ${stray.join(", ")}`);
      }
      if (res.aborted) return ctx.ui.notify("Stopped. Tests written so far are kept; run /wf:tests again to finish.", "info");

      const out = extractJson<{ tasks?: { id?: string; tests?: string[]; skip?: string | null }[]; assumptions?: string[]; spec_gaps?: string[] }>(res.text, "wf-tests");
      for (const t of targets) {
        const reported = out?.tasks?.find((x) => x.id === t.id);
        const oldFiles = new Set(spec.tasks[t.id]?.files ?? []);
        const files = parkedFiles(ctx.cwd, t.id).filter((rel) => {
          // Spec tests must be new files: overwriting an existing file would clobber other work.
          if (!oldFiles.has(rel) && fs.existsSync(path.join(ctx.cwd, rel))) {
            removeParked(ctx.cwd, t.id, rel);
            problems.push(`${t.id}: ${rel} already exists in the repo; spec tests must be new files (dropped)`);
            return false;
          }
          return true;
        });
        // A rewritten task that was already under way: remove repo copies of tests that no longer exist.
        if (t.status === "doing") for (const rel of oldFiles) if (!files.includes(rel)) fs.rmSync(path.join(ctx.cwd, rel), { force: true });
        if (files.length) spec.tasks[t.id] = { files, tests: (reported?.tests ?? []).filter(Boolean), hash: taskHash(t), at: now() };
        else if (reported?.skip) spec.tasks[t.id] = { files: [], tests: [], skip: reported.skip, hash: taskHash(t), at: now() };
        else {
          delete spec.tasks[t.id];
          problems.push(`${t.id}: no tests written${out ? "" : " (the tester produced no report)"}`);
        }
      }
      spec.gaps = (out?.spec_gaps ?? []).filter(Boolean);
      spec.assumptions = (out?.assumptions ?? []).filter(Boolean);
      saveIndex();
      if (spec.assumptions.length) led.append("assumptions.md", spec.assumptions.map((a) => `- tests: ${a}\n`).join(""));
      led.event({
        type: "tests",
        at: now(),
        covered: targets.filter((t) => spec.tasks[t.id]?.files.length).length,
        skipped: targets.filter((t) => spec.tasks[t.id]?.skip).length,
        gaps: spec.gaps.length,
        problems: problems.length,
      });

      const lines = targets.map((t) => {
        const x = spec.tasks[t.id];
        if (!x) return `- **${t.id}**: no tests`;
        if (x.skip) return `- **${t.id}**: no spec tests (${x.skip})`;
        return `- **${t.id}**: ${x.files.map((f) => `\`${f}\``).join(", ")}${x.tests.length ? `\n${x.tests.map((d) => `  - ${d}`).join("\n")}` : ""}`;
      });
      post(
        [
          `**Spec tests written** (parked in \`${led.rel("spec")}/\`, not in your code yet)`,
          "",
          ...lines,
          spec.gaps.length ? `\n**Gaps in the spec** (the tester had to guess; decide these):\n${spec.gaps.map((g) => `- ${g}`).join("\n")}` : "",
          spec.assumptions.length ? `\n**Tester's assumptions:**\n${spec.assumptions.map((a) => `- ${a}`).join("\n")}` : "",
          problems.length ? `\n⚠ ${problems.join("\n⚠ ")}` : "",
          "",
          tip("tests.done"),
        ]
          .filter((l) => l !== "")
          .join("\n"),
      );
    },
  });

  /* --------------------------------- undo -------------------------------- */

  const cpLabel = (c: Checkpoint) =>
    c.id === "start"
      ? `⌂ start of build (${c.at})`
      : c.id.startsWith("u")
        ? `↺ before undo (${c.at})`
        : `${c.id}  ${c.summary ?? `${c.task} (round did not finish)`}`;

  pi.registerCommand(cmd("undo"), {
    description: "Restore the working tree (and task list) to before a build round, picked from a list",
    handler: async (args, ctx) => {
      if (busy || !requireIdle(ctx)) return busy ? ctx.ui.notify("A build or review is running. Stop it first (Esc).", "warning") : undefined;
      const led = new Ledger(ctx.cwd);
      const st = requireScope(ctx, led);
      if (!st) return;
      const cps = led.checkpoints();
      if (!cps.length) return ctx.ui.notify(`No checkpoints yet: they're taken during /${cmd("build")}.`, "info");

      const newestFirst = [...cps].reverse();
      const [idArg, ...why] = args.trim().split(/\s+/).filter(Boolean);
      let target: Checkpoint | undefined;
      if (idArg) {
        target = cps.find((c) => c.id.toLowerCase() === idArg.toLowerCase());
        if (!target) ctx.ui.notify(`No checkpoint "${idArg}".`, "warning");
      } else if (ctx.hasUI) {
        const labels = newestFirst.map(cpLabel);
        const choice = await ctx.ui.select("Restore the working tree to the state BEFORE…", labels);
        target = choice ? newestFirst[labels.indexOf(choice)] : undefined;
        if (!target) return;
      }
      if (!target) {
        post(
          [`**Checkpoints** — restore to the state BEFORE one with \`/${cmd("undo")} <id> [why]\`:`, "", "```", ...newestFirst.map((c) => `${c.id.padEnd(6)} ${cpLabel(c)}`), "```"].join("\n"),
        );
        return;
      }

      const cur = snapshot(ctx.cwd, "wf: before undo");
      if (!cur) return ctx.ui.notify("Could not snapshot the working tree (is this a git repository?). Nothing was changed.", "error");
      const files = changedPaths(ctx.cwd, cur.commit, target.commit);
      const loaded = led.tasks();
      const curTasks = loaded.ok ? loaded.tasks : [];
      const taskChanges = curTasks
        .map((t) => {
          const old = target!.tasks.find((o) => o.id === t.id);
          if (!old) return `${t.id} removed (added after that point)`;
          return old.status !== t.status || (old.attempts ?? 0) !== (t.attempts ?? 0)
            ? `${t.id}: ${t.status} → ${old.status}${(old.attempts ?? 0) !== (t.attempts ?? 0) ? `, attempts ${old.attempts ?? 0}` : ""}`
            : "";
        })
        .filter(Boolean);
      const idx = cps.indexOf(target);
      const undone = cps.slice(idx).filter((c) => c.task).map((c) => c.id);
      const head = gitHead(ctx.cwd);
      const summary = [
        `Files: ${files.length ? `${files.slice(0, 20).join(", ")}${files.length > 20 ? ` … (+${files.length - 20})` : ""}` : "none"}`,
        `Tasks: ${taskChanges.length ? taskChanges.join("; ") : "unchanged"}`,
        ...(undone.length ? [`Rounds undone: ${undone.join(", ")}`] : []),
        ...(target.head && head && target.head !== head
          ? ["⚠ You committed since then: undo restores files but never moves your branch, so the undone work will show as uncommitted changes against your commit."]
          : []),
      ].join("\n");
      if (ctx.hasUI && !(await ctx.ui.confirm(`Undo to before ${target.id === "start" ? "the build" : target.id}?`, summary))) return;
      const reason = why.join(" ") || (ctx.hasUI ? ((await ctx.ui.input("Why? (optional: tells the next worker what to avoid)", "")) ?? "").trim() : "");

      restore(ctx.cwd, cur.commit, target.commit);
      const undoEntry: Checkpoint = {
        id: `u${cps.filter((c) => c.id.startsWith("u")).length + 1}`,
        at: now(),
        ...cur,
        head,
        tasks: curTasks,
        notes: led.read("notes.md"),
      };
      // Keep the start anchor; drop the target and everything after it; the state we just left becomes "before undo".
      led.saveCheckpoints([...cps.slice(0, idx).concat(target.id === "start" ? [target] : []), undoEntry]);
      led.saveTasks(target.tasks);
      led.write("notes.md", target.notes);

      const what = undone.length ? `undid ${undone.join(", ")}` : `restored ${target.id}`;
      led.append("log.md", `\n### Undo (${now()}) — back to before ${target.id}: ${what}${reason ? ` — ${reason}` : ""}\n`);
      led.event({ type: "undo", at: now(), to: target.id, rounds: undone });
      if (undone.length) {
        led.recordDecision(`The human undid rounds ${undone.join(", ")} (code and task list restored to before ${target.id})${reason ? `: ${reason}` : ""}.`);
        st.lastReport = { task: target.task ?? "", status: "partial", summary: `The human undid rounds ${undone.join(", ")}.`, changed: true };
      }
      st.lastRound = undefined;
      st.pause = undefined;
      st.tamper = undefined;
      if (target.tasks.some((t) => t.status === "todo" || t.status === "doing")) st.phase = "building";
      led.saveState(st);

      post(
        [
          `**↺ Undone to before ${target.id === "start" ? "the build" : target.id}** — ${what}; ${files.length} file(s) restored.`,
          summary.split("\n").slice(1).join("\n"),
          "",
          tip("undo.done", { id: undoEntry.id }),
        ].join("\n"),
      );
    },
  });

  /* -------------------------------- stats -------------------------------- */

  pi.registerCommand(cmd("stats"), {
    description: "Numbers for this feature (rounds, reliability, flags, tokens and context per role); /wf:stats all compares every feature by model",
    handler: async (args, ctx) => {
      if (args.trim().toLowerCase() === "all") {
        const { features, skipped } = loadAll(ctx.cwd);
        return post(`**wf stats — all features, grouped by worker model**\n\n${renderAll(features, skipped)}`);
      }
      const led = new Ledger(ctx.cwd);
      if (!requireScope(ctx, led)) return;
      const f = loadFeature(led.root);
      if (!f) return ctx.ui.notify("No stats for this feature: it was started before stats existed.", "info");
      post(renderCard(f));
    },
  });

  /* --------------------------------- help -------------------------------- */

  pi.registerCommand(cmd("help"), {
    description: "What to do next and how to handle edge cases. /wf:help <topic> shows one section",
    handler: async (args, ctx) => {
      const name = args.trim().toLowerCase();
      const body = name ? topic(name) : undefined;
      if (body) return post(`${body}\n\n(Full guide: ${HELP_PATH})`);
      const list = topics().map((t) => `- \`/${cmd("help")} ${t.name}\` — ${t.title}`);
      if (!list.length) return ctx.ui.notify(`Help file not found: ${HELP_PATH}`, "warning");
      post(
        [
          name ? `No help topic "${name}".` : "**wf help** — pick a topic:",
          "",
          ...list,
          "",
          `Full guide: ${HELP_PATH}`,
        ].join("\n"),
      );
    },
  });
}
