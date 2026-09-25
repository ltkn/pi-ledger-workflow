/**
 * pi-ledger-workflow (wf) — ledger-based self-orchestration for Pi.
 *
 *   /wf:scope <feature>   investigate + explore        (main session, you discuss)
 *   /wf:plan [guidance]   decisions + plan + tasks     (main session, you approve)
 *   /wf:build [answer]    manager → worker → verify    (fresh contexts, automatic)
 *   /wf:review [focus]    independent review           (fresh context)
 *   /wf:status            where things stand
 *   /wf:help [topic]      what to do next, and how to handle edge cases
 *
 * Based on the method of:
 *   V. Gao, V. Khosrowshahi, A. Khosrowshahi, X. Sun, J. Lee, E. Tran, S. (Sang Won) Lee.
 *   "GVS5H: Zero-Shot Self-Orchestration with Ledger-Based Control Improves Coding
 *   in Language Models." arXiv:2608.26480 (2026). https://arxiv.org/abs/2608.26480
 * This is an independent adaptation to interactive coding in Pi; see README.md
 * ("Credits" and "What's taken from the paper").
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  type Config,
  type Ledger as LedgerT,
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
  managerBrief,
  managerSystem,
  planPrompt,
  reviewerBrief,
  scopePrompt,
  summarizerBrief,
  taskLine,
  workerBrief,
  workerSystem,
} from "./prompts.ts";
import { HELP_PATH, tip, topic, topics } from "./help.ts";
import { extractBlock, extractJson, runFresh, stripFence } from "./runner.ts";
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

  /** Visible message in the session; also enters the main agent's context so you can discuss it. */
  const post = (content: string) => pi.sendMessage({ customType: "wf", content, display: true }, { triggerTurn: false });

  /** Short visible marker + full instructions that start a main-session turn. */
  const instruct = (marker: string, prompt: string) => {
    post(marker);
    pi.sendMessage({ customType: "wf-instruction", content: prompt, display: false }, { triggerTurn: true });
  };

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

      // A task paused on its attempt limit (and not since dropped/finished/reset by hand)
      // needs an answer like any question, and the answer buys it a fresh set of attempts.
      const exhausted =
        st.pause?.from === "harness" && st.pause.task
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
      } else if (st.pause && (st.pause.from !== "harness" || exhausted)) {
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
      st.pause = undefined;
      st.phase = "building";
      led.saveState(st);

      const verifyCmd = resolveVerify(cfg.verify, ctx.cwd);
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
      const askHuman = async (question: string, from: "worker" | "manager" | "harness", task?: string): Promise<boolean> => {
        post(`**wf needs a decision** (${from}${task ? `, ${task}` : ""})\n\n${question}`);
        const a = ctx.hasUI ? await ctx.ui.input("Answer now (empty = pause and discuss)", "") : undefined;
        if (a?.trim()) {
          led.recordDecision(`Q (${from}${task ? `, ${task}` : ""}): ${question}\nA: ${a.trim()}`);
          return true;
        }
        st.pause = { question, from, task };
        return false;
      };

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
              status === "done" && old?.status !== "done" && (!(old?.attempts ?? 0) || st.lastVerify?.ok === false)
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

      try {
        for (let round = 1; round <= cfg.maxRounds; round++) {
          if (abort.signal.aborted) {
            outcome = "aborted";
            break;
          }
          st.roundsTotal++;

          /* ---- MANAGE (fresh context, read-only) ---- */
          activity = "";
          render(round, "manager");
          const mres = await runFresh({
            cwd: ctx.cwd,
            role: "manager",
            systemPrompt: managerSystem(cfg),
            brief: managerBrief(led, cfg, st, tasks, round, cfg.maxRounds),
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
            led.append("log.md", `\n### Round ${st.roundsTotal} — finish vetoed (${st.lastVerify?.ok === false ? "verification failing" : "unfinished tasks"})\n`);
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
            if (!(await askHuman(q, "harness", next.id))) {
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
          activity = "";
          render(round, `worker ${next.id}`);
          const wres = await runFresh({
            cwd: ctx.cwd,
            role: "worker",
            systemPrompt: workerSystem(cfg),
            brief: workerBrief(led, cfg, st, next, dec?.instruction ?? "", verifyCmd),
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
            const salvaged = extractJson<WorkerReport>(sres.text, "wf-report");
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

          const fpAfter = fingerprint(ctx.cwd);
          lastRoundChanged = fpAfter === undefined || fpAfter !== fpBefore;

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

          if (report.status === "done" && st.lastVerify?.ok !== false) next.status = "done";
          st.lastReport = { ...report, task: next.id, changed: lastRoundChanged };
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
              `Verify: ${st.lastVerify?.summary.split("\n")[0] ?? "-"}\n` +
              `Changed files this round: ${lastRoundChanged ? "yes" : "no"} · cost $${(mres.cost + wres.cost).toFixed(4)}\n`,
          );
          led.saveState(st);

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
        unsubEsc?.();
        ctx.ui.setWidget("wf", undefined);
        ctx.ui.setStatus("wf", undefined);
      }

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
      const tipKey =
        outcome === "paused" ? (st.pause?.from === "harness" && st.pause.task ? "paused-attempts" : "paused-question") : outcome;
      const whatNow = tip(`build.${tipKey}`, { task: st.pause?.task ?? "", max: cfg.maxTaskAttempts, rounds: cfg.maxRounds });
      post(
        [
          `**${headline[outcome]}**${outcomeNote ? ` — ${outcomeNote}` : ""}`,
          "",
          "```",
          ...tasks.map(taskLine),
          "```",
          `Verification: ${st.lastVerify?.summary.split("\n")[0] ?? "not run"}`,
          assumptionsThisRun.length ? `\nAssumptions made (review these):\n${assumptionsThisRun.map((a) => `- ${a}`).join("\n")}` : "",
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
          brief: reviewerBrief(led, st, tasks, changedSinceBase(ctx.cwd, st.baseCommit), diffStat(ctx.cwd, st.baseCommit), args.trim()),
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
        `next: ${phaseNext[st.phase]}`,
        `ledger: ${led.rel("")} · help: /${cmd("help")}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
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
