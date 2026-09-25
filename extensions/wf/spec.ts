/**
 * Spec tests: acceptance tests written from the spec by a fresh tester before the
 * build, reviewed by the human, and parked in the ledger (.pi/wf/spec/<task>/<repo path>)
 * so they don't break compilation. The harness copies a task's tests into the repo
 * when the task starts and restores them before every test run, so implementers
 * can't change them.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { LEDGER_DIR, type Task } from "./ledger.ts";

export const SPEC_DIR = path.join(LEDGER_DIR, "spec");

export interface SpecTask {
  /** repo-relative paths of the parked test files */
  files: string[];
  /** one line per test: what it asserts */
  tests: string[];
  /** set when the task has no spec tests on purpose */
  skip?: string;
  /** hash of the task's title/detail/acceptance when the tests were written */
  hash: string;
  at: string;
}

export interface Spec {
  /** "skipped": the human chose to build this feature without spec tests */
  status: "written" | "skipped";
  reason?: string;
  tasks: Record<string, SpecTask>;
  /** from the latest tester run */
  gaps?: string[];
  assumptions?: string[];
}

export type SpecState = "ok" | "skipped" | "stale" | "missing";

export const taskHash = (t: Task) =>
  createHash("sha1").update(`${t.title}\n${t.detail ?? ""}\n${t.acceptance ?? ""}`).digest("hex").slice(0, 12);

export function specState(spec: Spec | undefined, t: Task): SpecState {
  const s = spec?.tasks[t.id];
  if (!s) return "missing";
  if (s.skip) return "skipped";
  return s.hash === taskHash(t) ? "ok" : "stale";
}

const parkedRoot = (cwd: string, id: string) => path.join(cwd, SPEC_DIR, id);

/** Repo-relative paths of the files parked for a task. */
export function parkedFiles(cwd: string, id: string): string[] {
  const root = parkedRoot(cwd, id);
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(root, p).split(path.sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

export function removeParked(cwd: string, id: string, rel?: string): void {
  fs.rmSync(rel ? path.join(parkedRoot(cwd, id), rel) : parkedRoot(cwd, id), { recursive: true, force: true });
}

export function readParked(cwd: string, id: string, rel: string): string {
  return fs.readFileSync(path.join(parkedRoot(cwd, id), rel), "utf8");
}

/** Copy a task's parked tests into the repo wherever the repo copy is missing or different. Returns the paths rewritten. */
export function syncSpecFiles(cwd: string, id: string, files: string[]): string[] {
  const rewritten: string[] = [];
  for (const rel of files) {
    const src = path.join(parkedRoot(cwd, id), rel);
    const dest = path.join(cwd, rel);
    if (!fs.existsSync(src)) continue;
    const want = fs.readFileSync(src);
    if (fs.existsSync(dest) && fs.readFileSync(dest).equals(want)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, want);
    rewritten.push(rel);
  }
  return rewritten;
}

/** Human-readable index of the spec, written to .pi/wf/spec/index.md. */
export function renderIndex(spec: Spec, tasks: Task[]): string {
  const lines = ["# Spec tests", "", "Written from the spec before the build. Implementers can't change them.", ""];
  for (const t of tasks) {
    const st = specState(spec, t);
    const s = spec.tasks[t.id];
    lines.push(`## ${t.id} — ${t.title}${st === "stale" ? " (STALE: the task changed since; run /wf:tests)" : ""}`);
    if (!s) lines.push("- (no spec tests yet)");
    else if (s.skip) lines.push(`- no spec tests: ${s.skip}`);
    else {
      for (const f of s.files) lines.push(`- file: \`${f}\``);
      for (const x of s.tests) lines.push(`- ${x}`);
    }
    lines.push("");
  }
  if (spec.gaps?.length) lines.push("## Gaps in the spec (the tester had to guess)", "", ...spec.gaps.map((g) => `- ${g}`), "");
  if (spec.assumptions?.length) lines.push("## Tester's assumptions", "", ...spec.assumptions.map((a) => `- ${a}`), "");
  return lines.join("\n");
}
