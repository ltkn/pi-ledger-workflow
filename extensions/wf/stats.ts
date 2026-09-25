/**
 * /wf:stats: numbers per feature, from the structured events the harness appends to
 * .pi/wf/events.jsonl (archived with each feature). Answers "does it help with model X"
 * from your own data. Features built before events existed are skipped.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type CallEvent, LEDGER_DIR, type RoundEvent, type State, type Task, type WfEvent } from "./ledger.ts";
import type { Spec } from "./spec.ts";

export interface FeatureData {
  feature: string;
  phase?: string;
  events: WfEvent[];
  tasks: Task[];
  spec?: Spec;
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** A feature's data from a ledger directory, or undefined if it has no events (built before stats existed). */
export function loadFeature(dir: string): FeatureData | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8");
  } catch {
    return undefined;
  }
  const events = raw
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as WfEvent];
      } catch {
        return [];
      }
    });
  const st = readJson<State>(path.join(dir, "state.json"));
  const t = readJson<{ tasks?: Task[] }>(path.join(dir, "tasks.json"));
  return { feature: st?.feature ?? path.basename(dir), phase: st?.phase, events, tasks: t?.tasks ?? [], spec: readJson<Spec>(path.join(dir, "spec.json")) };
}

/** Archived features (oldest first) then the current one; `skipped` counts those without stats. */
export function loadAll(cwd: string): { features: FeatureData[]; skipped: number } {
  const root = path.join(cwd, LEDGER_DIR);
  const archive = path.join(root, "archive");
  const dirs = [
    ...(fs.existsSync(archive) ? fs.readdirSync(archive).sort().map((d) => path.join(archive, d)) : []),
    ...(fs.existsSync(path.join(root, "state.json")) ? [root] : []),
  ];
  const features: FeatureData[] = [];
  let skipped = 0;
  for (const d of dirs) {
    const f = loadFeature(d);
    if (f) features.push(f);
    else if (d !== root) skipped++; // the current feature simply has no events yet
  }
  return { features, skipped };
}

/* ------------------------------- formatting ------------------------------ */

const human = (n: number) => (n < 1000 ? `${n}` : n < 1e6 ? `${(n / 1e3).toFixed(1)}k` : `${(n / 1e6).toFixed(2)}M`);
const dur = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "–");
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
const lpad = (s: string, n: number) => s.padStart(n);
const mostCommon = (xs: (string | undefined)[]) => {
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x ?? "(session)", (counts.get(x ?? "(session)") ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "–";
};

/* -------------------------------- summary -------------------------------- */

interface RoleStats {
  calls: number;
  prompt: number;
  output: number;
  cached: number;
  peak: number;
  peakSum: number;
  cost: number;
  ms: number;
  model: string;
}

export interface Summary {
  tasks: { total: number; done: number; plan: number; manager: number; fix: number; review: number; dropped: number };
  rounds: number;
  perDoneTask: number;
  firstTry: [number, number];
  most?: [string, number];
  reports: { ok: number; resumed: number; salvaged: number; lost: number };
  managerMissing: [number, number];
  failingRounds: number;
  vetoes: number;
  flags: { lostWork: number; tampering: number; specEdits: number };
  undo: { count: number; rounds: number };
  questions: { total: number; inline: number };
  stops: Record<string, number>;
  reviews: string[];
  spec: string;
  roles: Map<string, RoleStats>;
  total: RoleStats;
}

export function summarize(f: FeatureData): Summary {
  const calls = f.events.filter((e): e is CallEvent => e.type === "call");
  const rounds = f.events.filter((e): e is RoundEvent => e.type === "round");
  const src = (t: Task) => t.source ?? "plan";
  const live = f.tasks.filter((t) => t.status !== "dropped");
  const done = f.tasks.filter((t) => t.status === "done");

  const perTask = new Map<string, number>();
  for (const r of rounds) perTask.set(r.task, (perTask.get(r.task) ?? 0) + 1);
  const doneRounds = done.map((t) => perTask.get(t.id) ?? 0);
  const most = [...perTask].sort((a, b) => b[1] - a[1])[0];

  const newRole = (): RoleStats => ({ calls: 0, prompt: 0, output: 0, cached: 0, peak: 0, peakSum: 0, cost: 0, ms: 0, model: "" });
  const roles = new Map<string, RoleStats>();
  const total = newRole();
  for (const role of ["tester", "manager", "worker", "resume", "summarizer", "reviewer"]) {
    const cs = calls.filter((c) => c.role === role);
    if (!cs.length) continue;
    const r = newRole();
    for (const c of cs) {
      for (const x of [r, total]) {
        x.calls++;
        x.prompt += c.input + c.cacheRead + c.cacheWrite;
        x.output += c.output;
        x.cached += c.cacheRead;
        x.peak = Math.max(x.peak, c.peakContext);
        x.peakSum += c.peakContext;
        x.cost += c.cost;
        x.ms += c.ms;
      }
    }
    r.model = mostCommon(cs.map((c) => c.model));
    roles.set(role, r);
  }

  const stops: Record<string, number> = {};
  for (const e of f.events) if (e.type === "build-end" && e.outcome !== "done") stops[e.outcome] = (stops[e.outcome] ?? 0) + 1;
  const flagCount = (kind: string) => rounds.filter((r) => r.flags.some((x) => x.startsWith(kind))).length;
  const managers = calls.filter((c) => c.role === "manager");
  const questions = f.events.filter((e) => e.type === "question") as { answered: boolean }[];
  const undos = f.events.filter((e) => e.type === "undo") as { rounds: string[] }[];

  let spec = "not written";
  if (f.spec?.status === "skipped") spec = `skipped (${f.spec.reason ?? "no reason"})`;
  else if (f.spec) {
    const covered = live.filter((t) => f.spec!.tasks[t.id]?.files.length).length;
    const skipped = live.filter((t) => f.spec!.tasks[t.id]?.skip).length;
    spec = `${covered}/${live.length} tasks covered${skipped ? `, ${skipped} skipped` : ""}${f.spec.gaps?.length ? `, ${f.spec.gaps.length} gaps` : ""}`;
  }

  return {
    tasks: {
      total: f.tasks.length,
      done: done.length,
      plan: f.tasks.filter((t) => src(t) === "plan").length,
      manager: f.tasks.filter((t) => src(t) === "manager").length,
      fix: f.tasks.filter((t) => src(t) === "verify").length,
      review: f.tasks.filter((t) => src(t) === "review").length,
      dropped: f.tasks.length - live.length,
    },
    rounds: rounds.length,
    perDoneTask: doneRounds.length ? doneRounds.reduce((a, b) => a + b, 0) / doneRounds.length : 0,
    firstTry: [doneRounds.filter((n) => n === 1).length, doneRounds.length],
    most,
    reports: {
      ok: rounds.filter((r) => r.report === "ok").length,
      resumed: rounds.filter((r) => r.report === "resumed").length,
      salvaged: rounds.filter((r) => r.report === "salvaged").length,
      lost: rounds.filter((r) => r.report === "lost").length,
    },
    managerMissing: [managers.filter((c) => c.decided === false).length, managers.length],
    failingRounds: rounds.filter((r) => r.verify === false).length,
    vetoes: f.events.filter((e) => e.type === "veto").length,
    flags: { lostWork: flagCount("lost-work"), tampering: flagCount("tampering"), specEdits: rounds.filter((r) => r.notices.length).length },
    undo: { count: undos.length, rounds: undos.reduce((a, u) => a + u.rounds.length, 0) },
    questions: { total: questions.length, inline: questions.filter((q) => q.answered).length },
    stops,
    reviews: f.events.filter((e) => e.type === "review").map((e) => (e as { verdict: string; followups: number }).verdict + ((e as { followups: number }).followups ? ` (${(e as { followups: number }).followups} R-tasks)` : "")),
    spec,
    roles,
    total,
  };
}

/* --------------------------------- render -------------------------------- */

export function renderCard(f: FeatureData): string {
  const s = summarize(f);
  const t = s.tasks;
  const origin = [`planned ${t.plan}`, t.manager && `manager +${t.manager}`, t.fix && `fix +${t.fix}`, t.review && `review +${t.review}`, t.dropped && `dropped ${t.dropped}`]
    .filter(Boolean)
    .join(" · ");
  const stops = Object.entries(s.stops).map(([k, v]) => `${v} ${k}`).join(", ");
  const lines = [
    `wf stats — ${f.feature}${f.phase ? `  (phase: ${f.phase})` : ""}`,
    "",
    `Tasks        ${t.done} done of ${t.total - t.dropped} · ${origin}`,
    `Rounds       ${s.rounds} worker rounds · ${s.perDoneTask.toFixed(1)} per done task · first try ${s.firstTry[0]}/${s.firstTry[1]} (${pct(...s.firstTry)})${s.most ? ` · most: ${s.most[0]} (${s.most[1]})` : ""}`,
    `Reliability  reports ${s.reports.ok} ok, ${s.reports.resumed} resumed, ${s.reports.salvaged} salvaged, ${s.reports.lost} lost · manager decisions missing ${s.managerMissing[0]}/${s.managerMissing[1]}`,
    `Tests        failed after ${s.failingRounds} of ${s.rounds} rounds · finish vetoed ${s.vetoes}× · spec tests: ${s.spec}`,
    `Flags        lost work ${s.flags.lostWork} · tampering ${s.flags.tampering} · spec edits restored ${s.flags.specEdits} · undo ${s.undo.count}${s.undo.count ? ` (${s.undo.rounds} rounds)` : ""}`,
    `You          questions ${s.questions.total} (${s.questions.inline} answered inline)${stops ? ` · stops: ${stops}` : ""}`,
    `Review       ${s.reviews.length ? s.reviews.join(" → ") : "not run"}`,
    "",
    "Tokens and context (fresh calls only; your main session isn't counted)",
    `${pad("role", 11)}${lpad("calls", 6)}${lpad("peak ctx", 10)}${lpad("avg peak", 10)}${lpad("prompt", 9)}${lpad("output", 9)}${lpad("cached", 8)}${lpad("cost", 9)}${lpad("time", 9)}  model`,
  ];
  const row = (name: string, r: RoleStats, model: string) =>
    `${pad(name, 11)}${lpad(String(r.calls), 6)}${lpad(human(r.peak), 10)}${lpad(name === "total" ? "" : human(Math.round(r.peakSum / r.calls)), 10)}${lpad(human(r.prompt), 9)}${lpad(human(r.output), 9)}${lpad(pct(r.cached, r.prompt), 8)}${lpad(`$${r.cost.toFixed(2)}`, 9)}${lpad(dur(r.ms), 9)}  ${model}`;
  for (const [name, r] of s.roles) lines.push(row(name, r, r.model));
  if (s.roles.size) lines.push(row("total", s.total, ""));
  else lines.push("(no fresh calls yet)");
  lines.push("", "peak ctx: the largest prompt one call sent, i.e. how full that model's context got. Compare it with your model's context window.");
  return "```\n" + lines.join("\n") + "\n```";
}

export function renderAll(features: FeatureData[], skipped: number): string {
  if (!features.length) return `No features with stats yet${skipped ? ` (${skipped} built before stats existed)` : ""}.`;
  const rows = features.map((f) => ({ f, s: summarize(f) }));
  const workerModel = (x: (typeof rows)[number]) => x.s.roles.get("worker")?.model ?? "(no build)";
  const groups = new Map<string, typeof rows>();
  for (const x of rows) groups.set(workerModel(x), [...(groups.get(workerModel(x)) ?? []), x]);

  const header = `${pad("feature", 28)}${lpad("tasks", 7)}${lpad("rnd/task", 9)}${lpad("1st try", 8)}${lpad("res", 4)}${lpad("salv", 5)}${lpad("flags", 6)}  ${pad("review", 16)}${lpad("peak w", 8)}${lpad("tokens", 8)}${lpad("cost", 8)}${lpad("time", 9)}`;
  const lines = [header];
  for (const [model, xs] of groups) {
    const mgr = mostCommon(xs.map((x) => x.s.roles.get("manager")?.model));
    lines.push("", `── worker: ${model} · manager: ${mgr} · ${xs.length} feature(s)`);
    for (const { f, s } of xs) {
      const flags = s.flags.lostWork + s.flags.tampering;
      lines.push(
        `${pad(f.feature, 28)}${lpad(`${s.tasks.done}/${s.tasks.total - s.tasks.dropped}`, 7)}${lpad(s.perDoneTask.toFixed(1), 9)}${lpad(pct(...s.firstTry), 8)}${lpad(String(s.reports.resumed), 4)}${lpad(String(s.reports.salvaged + s.reports.lost), 5)}${lpad(String(flags), 6)}  ${pad(s.reviews.at(-1)?.replace("changes_needed", "changes").replace(/ \((\d+) R-tasks\)/, " +$1R") ?? "–", 16)}${lpad(human(s.roles.get("worker")?.peak ?? 0), 8)}${lpad(human(s.total.prompt + s.total.output), 8)}${lpad(`$${s.total.cost.toFixed(2)}`, 8)}${lpad(dur(s.total.ms), 9)}`,
      );
    }
    if (xs.length > 1) {
      const avg = (g: (x: (typeof xs)[number]) => number) => xs.reduce((a, x) => a + g(x), 0) / xs.length;
      const first = xs.reduce((a, x) => [a[0] + x.s.firstTry[0], a[1] + x.s.firstTry[1]], [0, 0]);
      lines.push(
        `${pad("  average", 28)}${lpad("", 7)}${lpad(avg((x) => x.s.perDoneTask).toFixed(1), 9)}${lpad(pct(first[0], first[1]), 8)}${lpad(avg((x) => x.s.reports.resumed).toFixed(1), 4)}${lpad(avg((x) => x.s.reports.salvaged + x.s.reports.lost).toFixed(1), 5)}${lpad(avg((x) => x.s.flags.lostWork + x.s.flags.tampering).toFixed(1), 6)}  ${pad("", 16)}${lpad(human(Math.round(avg((x) => x.s.roles.get("worker")?.peak ?? 0))), 8)}${lpad(human(Math.round(avg((x) => x.s.total.prompt + x.s.total.output))), 8)}${lpad(`$${avg((x) => x.s.total.cost).toFixed(2)}`, 8)}${lpad(dur(avg((x) => x.s.total.ms)), 9)}`,
      );
    }
  }
  if (skipped) lines.push("", `(${skipped} older feature(s) built before stats existed are not shown)`);
  return "```\n" + lines.join("\n") + "\n```";
}
