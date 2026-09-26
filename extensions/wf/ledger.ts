/**
 * Ledger: the shared, on-disk workspace that fresh contexts coordinate through.
 * The harness owns every write to .pi/wf/ so caps and formats are enforced
 * (paper §2: plan/notes are capped when written so neither grows without bound).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const PREFIX = "wf";
export const LEDGER_DIR = path.join(".pi", "wf");
/** Finished features live outside the ledger, so fresh roles exploring .pi/wf/ only ever see the current one. */
export const ARCHIVE_DIR = path.join(".pi", "wf-archive");
const LEDGER_PATHSPEC = ":(exclude).pi/wf";

export type TaskStatus = "todo" | "doing" | "done" | "dropped";

export interface Task {
  id: string;
  title: string;
  detail?: string;
  acceptance?: string;
  status: TaskStatus;
  attempts?: number;
  source?: "plan" | "manager" | "verify" | "review" | "merge";
}

export interface VerifyResult {
  ok: boolean | null; // null = no verify command configured
  command: string | null;
  summary: string;
  fingerprint?: string;
  at: string;
}

export interface WorkerReport {
  status: "done" | "partial" | "blocked" | "needs_input";
  summary: string;
  /** legacy: notes now arrive in a separate wf-notes block */
  notes?: string;
  assumptions?: string[];
  question?: string;
  proposed?: string[];
}

export interface Pause {
  question: string;
  from: "worker" | "manager" | "harness";
  task?: string;
  /** harness pauses: why the loop stopped */
  kind?: "attempts" | "lost-work" | "tampering";
}

/** One entry in /wf:undo's list: the state to go back to, files and ledger alike. */
export interface Checkpoint {
  /** "start", "r<round>", or "u<n>" for the state saved before an undo */
  id: string;
  at: string;
  /** shadow snapshot of the working tree at this point */
  commit: string;
  tree: string;
  /** HEAD at this point, to warn when you committed since */
  head?: string;
  tasks: Task[];
  notes: string;
  /** rounds: the task worked on, the files it changed, and a one-line outcome */
  task?: string;
  files?: string[];
  summary?: string;
}

/* ------------------------------ stats events ------------------------------ */

/** One fresh model call (manager, worker, summarizer, reviewer, tester). */
export interface CallEvent {
  type: "call";
  at: string;
  role: string;
  model?: string;
  thinking?: string;
  round?: number;
  task?: string;
  cost: number;
  ms: number;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** the largest prompt a single turn sent: how full the context got */
  peakContext: number;
  /** manager only: did it produce a parseable decision */
  decided?: boolean;
  /** the model's context window, when known, to put peakContext in proportion */
  window?: number;
  /** worker only: this attempt ran on the escalation model */
  escalated?: boolean;
}

/** One worker round, as the harness saw it. */
export interface RoundEvent {
  type: "round";
  at: string;
  round: number;
  task: string;
  attempt: number;
  status: string;
  /** "resumed": the worker's own session wrote it when asked; "salvaged": the summarizer rebuilt it; "lost": neither */
  report: "ok" | "resumed" | "salvaged" | "lost";
  verify: boolean | null;
  changed: boolean;
  files?: number;
  added?: number;
  removed?: number;
  flags: string[];
  notices: string[];
  taskDone: boolean;
  /** this attempt ran on the escalation model */
  escalated?: boolean;
  model?: string;
}

export type WfEvent =
  | CallEvent
  | RoundEvent
  | { type: "question"; at: string; from: string; kind?: string; task?: string; answered: boolean }
  | { type: "veto"; at: string; round: number; reason: string }
  | { type: "build-end"; at: string; outcome: string }
  | { type: "undo"; at: string; to: string; rounds: string[] }
  | { type: "review"; at: string; verdict: string; followups: number }
  | { type: "tests"; at: string; covered: number; skipped: number; gaps: number; problems: number };

/** What the harness itself saw in the last round (the manager's ground truth next to the worker's report). */
export interface RoundRecord {
  round: number;
  task: string;
  stat: string;
  patch: string;
  flags: string[];
  /** things worth knowing that don't block the task (e.g. spec tests restored after a worker edited them) */
  notices?: string[];
}

export interface State {
  phase: "scoped" | "planned" | "building" | "paused" | "built" | "reviewed";
  feature: string;
  baseCommit?: string;
  roundsTotal: number;
  costTotal: number;
  pause?: Pause;
  lastVerify?: VerifyResult;
  /** changed: whether that round changed files on disk */
  lastReport?: WorkerReport & { task: string; changed?: boolean };
  lastRound?: RoundRecord;
  /** test-tampering flags per task; the second one pauses the build */
  tamper?: Record<string, number>;
  updatedAt: string;
}

export interface Config {
  /** Automatic manager→worker cycles per /wf:build invocation (paper: MAX_ITERS=10). */
  maxRounds: number;
  /** Rounds a single task may consume before the harness asks you. */
  maxTaskAttempts: number;
  /** "auto" detects mvn/gradle/npm/…; null disables; any string is run in a shell. */
  verify: string | null;
  verifyTimeoutSec: number;
  /** "ask": workers/manager may pause for a decision. "assume": never pause, record assumptions. */
  questions: "ask" | "assume";
  /** Max chars of each ledger file fed into briefs; 0 = no cap (the default). For small-context models. */
  caps: { plan: number; notes: number; context: number; verifyOutput: number };
  /** provider/model per role; unset = the model of your current Pi session. */
  models: { manager?: string; worker?: string; reviewer?: string; tester?: string };
  /** thinking level per role; unset = your current session's level. */
  thinking: { manager?: string; worker?: string; reviewer?: string; tester?: string };
  /** Load your other Pi extensions inside fresh workers (wf itself is never needed there). */
  childExtensions: boolean;
  workerTools: string[];
  /** Shadow snapshots around every round: real diffs for the manager, lost-work/tampering detection, /wf:undo. */
  checkpoints: boolean;
  /** Acceptance tests written from the spec before the build (/wf:tests); only when a verify command exists. */
  specTests: boolean;
  /** At the end of a build, merge Spec files into the existing test files they extend (a last task, M1). Off by default. */
  mergeSpecTests: boolean;
  /** Give a task's next attempts to a stronger model once it has failed `afterAttempts` times (set by /wf:models mixed). */
  escalate: { afterAttempts: number; model: string } | null;
}

export const DEFAULT_CONFIG: Config = {
  maxRounds: 10,
  maxTaskAttempts: 4,
  verify: "auto",
  verifyTimeoutSec: 900,
  questions: "ask",
  caps: { plan: 0, notes: 0, context: 0, verifyOutput: 20000 },
  models: {},
  thinking: {},
  childExtensions: false,
  workerTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  checkpoints: true,
  specTests: true,
  mergeSpecTests: false,
  escalate: null,
};

/** Truncate to n chars with a marker; n <= 0 means no cap. */
/** Written into every config.json before 0.3; see Ledger.config(). */
const OLD_DEFAULT_CAPS = { plan: 4000, notes: 8000, context: 6000, verifyOutput: 4000 };

export function cap(text: string, n: number): string {
  if (!text || n <= 0 || text.length <= n) return text ?? "";
  return `${text.slice(0, n)}\n…[truncated ${text.length - n} chars]`;
}

export function now(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export class Ledger {
  readonly root: string;
  readonly archiveRoot: string;
  constructor(readonly cwd: string) {
    this.root = path.join(cwd, LEDGER_DIR);
    this.archiveRoot = path.join(cwd, ARCHIVE_DIR);
    this.migrateArchive();
  }

  /** Before 0.3 the archive was .pi/wf/archive/; move it out of the ledger. */
  private migrateArchive(): void {
    const legacy = path.join(this.root, "archive");
    if (!fs.existsSync(legacy)) return;
    this.ensureArchive();
    for (const f of fs.readdirSync(legacy)) {
      const dest = path.join(this.archiveRoot, fs.existsSync(path.join(this.archiveRoot, f)) ? `${f}-moved` : f);
      fs.renameSync(path.join(legacy, f), dest);
    }
    fs.rmSync(legacy, { recursive: true, force: true });
  }

  /** The archive ignores itself in git, so no project .gitignore change is needed. */
  private ensureArchive(): void {
    fs.mkdirSync(this.archiveRoot, { recursive: true });
    const ignore = path.join(this.archiveRoot, ".gitignore");
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
  }

  p(name: string): string {
    return path.join(this.root, name);
  }
  rel(name: string): string {
    return path.join(LEDGER_DIR, name);
  }
  exists(name: string): boolean {
    return fs.existsSync(this.p(name));
  }
  read(name: string, limit?: number): string {
    try {
      const t = fs.readFileSync(this.p(name), "utf8");
      return limit ? cap(t, limit) : t;
    } catch {
      return "";
    }
  }
  write(name: string, content: string): void {
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(this.p(name), content, "utf8");
  }
  append(name: string, content: string): void {
    fs.mkdirSync(this.root, { recursive: true });
    fs.appendFileSync(this.p(name), content, "utf8");
  }

  config(): Config {
    if (!this.exists("config.json")) this.write("config.json", `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
    try {
      const raw = JSON.parse(this.read("config.json"));
      // Caps identical to the old defaults were never a choice: drop them so the new defaults (no caps) apply.
      if (JSON.stringify(raw.caps) === JSON.stringify(OLD_DEFAULT_CAPS)) {
        delete raw.caps;
        this.write("config.json", `${JSON.stringify(raw, null, 2)}\n`);
      }
      return {
        ...DEFAULT_CONFIG,
        ...raw,
        caps: { ...DEFAULT_CONFIG.caps, ...(raw.caps ?? {}) },
        models: { ...(raw.models ?? {}) },
        thinking: { ...(raw.thinking ?? {}) },
      };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  state(): State | undefined {
    try {
      return JSON.parse(this.read("state.json")) as State;
    } catch {
      return undefined;
    }
  }
  saveState(s: State): void {
    s.updatedAt = now();
    this.write("state.json", `${JSON.stringify(s, null, 2)}\n`);
  }

  tasks(): { ok: true; tasks: Task[] } | { ok: false; error: string } {
    if (!this.exists("tasks.json")) return { ok: false, error: "tasks.json does not exist" };
    try {
      const raw = JSON.parse(this.read("tasks.json"));
      const list = Array.isArray(raw) ? raw : raw.tasks;
      if (!Array.isArray(list) || list.length === 0) return { ok: false, error: "tasks.json has no tasks" };
      const tasks: Task[] = list.map((t: any, i: number) => ({
        id: String(t.id ?? `T${i + 1}`),
        title: String(t.title ?? t.name ?? `Task ${i + 1}`),
        detail: t.detail ?? t.description,
        acceptance: t.acceptance,
        status: (["todo", "doing", "done", "dropped"].includes(t.status) ? t.status : "todo") as TaskStatus,
        attempts: Number(t.attempts ?? 0),
        source: t.source ?? "plan",
      }));
      return { ok: true, tasks };
    } catch (e) {
      return { ok: false, error: `tasks.json is not valid JSON (${(e as Error).message})` };
    }
  }
  saveTasks(tasks: Task[]): void {
    this.write("tasks.json", `${JSON.stringify({ tasks }, null, 2)}\n`);
  }

  checkpoints(): Checkpoint[] {
    try {
      const list = JSON.parse(this.read("checkpoints.json"));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }
  /** Append a stats event (.pi/wf/events.jsonl, archived with the feature). */
  event(e: WfEvent): void {
    this.append("events.jsonl", `${JSON.stringify(e)}\n`);
  }

  /** undefined until /wf:tests ran or the human chose to build without spec tests */
  spec(): import("./spec.ts").Spec | undefined {
    try {
      return JSON.parse(this.read("spec.json"));
    } catch {
      return undefined;
    }
  }
  saveSpec(spec: import("./spec.ts").Spec): void {
    this.write("spec.json", `${JSON.stringify(spec, null, 2)}\n`);
  }

  saveCheckpoints(list: Checkpoint[]): void {
    this.write("checkpoints.json", `${JSON.stringify(list, null, 2)}\n`);
  }

  recordDecision(text: string): void {
    if (!this.exists("decisions.md")) this.write("decisions.md", "# Decisions (binding for every worker)\n\n");
    this.append("decisions.md", `- [${now()}] ${text.replace(/\n/g, "\n  ")}\n`);
  }

  /** Move the current feature's ledger aside so a new /wf:scope starts clean. */
  archive(): string | undefined {
    if (!fs.existsSync(this.root)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    this.ensureArchive();
    const dest = path.join(this.archiveRoot, stamp);
    fs.mkdirSync(dest, { recursive: true });
    for (const f of fs.readdirSync(this.root)) {
      if (f === "config.json") continue;
      fs.renameSync(path.join(this.root, f), path.join(dest, f));
    }
    return dest;
  }
}

/* ------------------------------ git helpers ------------------------------ */

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

export function isGitRepo(cwd: string): boolean {
  return git(cwd, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
}

export function gitHead(cwd: string): string | undefined {
  return git(cwd, ["rev-parse", "HEAD"])?.trim() || undefined;
}

/** Hash of the working tree (tracked diff + untracked files), ledger excluded. Detects "did this round change anything". */
export function fingerprint(cwd: string): string | undefined {
  if (!isGitRepo(cwd)) return undefined;
  const h = createHash("sha1");
  h.update(git(cwd, ["diff", "HEAD", "--", ".", LEDGER_PATHSPEC]) ?? "");
  const untracked = (git(cwd, ["ls-files", "--others", "--exclude-standard", "--", ".", LEDGER_PATHSPEC]) ?? "")
    .split("\n")
    .filter(Boolean);
  for (const f of untracked) {
    h.update(f);
    try {
      const st = fs.statSync(path.join(cwd, f));
      h.update(st.size > 1_000_000 ? `${st.size}:${st.mtimeMs}` : fs.readFileSync(path.join(cwd, f)));
    } catch {
      /* ignore */
    }
  }
  return h.digest("hex");
}

/** Files changed since the feature's base commit (tracked + untracked), ledger excluded. */
export function changedSinceBase(cwd: string, base?: string): string[] | undefined {
  if (!isGitRepo(cwd)) return undefined;
  const tracked = git(cwd, ["diff", "--name-only", base ?? "HEAD", "--", ".", LEDGER_PATHSPEC]) ?? "";
  const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard", "--", ".", LEDGER_PATHSPEC]) ?? "";
  return [...new Set(`${tracked}\n${untracked}`.split("\n").filter(Boolean))];
}

export function diffStat(cwd: string, base?: string): string {
  return git(cwd, ["diff", "--stat", base ?? "HEAD", "--", ".", LEDGER_PATHSPEC])?.trim() ?? "";
}
