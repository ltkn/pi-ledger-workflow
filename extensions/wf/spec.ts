/**
 * Spec tests: acceptance tests written from the spec by a fresh tester before the
 * build, reviewed by the human, and parked in the ledger (.pi/wf/spec/<task>/<repo path>)
 * so they don't break compilation. The harness copies a task's tests into the repo
 * when the task starts and restores them before every test run, so implementers
 * can't change them.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { TEST_FILE } from "./checkpoint.ts";
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
  /** spec file → the existing test file it adds to, as the tester reported it; merged into it at the end of the build */
  extends?: Record<string, string>;
  /** spec file → the test file it was merged into */
  merged?: Record<string, string>;
}

export interface MergePair {
  task: string;
  spec: string;
  target: string;
}

/** Spec files of finished tasks that add to an existing test file and haven't been merged into it yet. */
export function pendingMerges(spec: Spec | undefined, tasks: Task[]): MergePair[] {
  if (spec?.status !== "written") return [];
  return tasks
    .filter((t) => t.status === "done")
    .flatMap((t) =>
      Object.entries(spec.tasks[t.id]?.extends ?? {})
        .filter(([f]) => !spec.tasks[t.id]?.merged?.[f])
        .map(([f, target]) => ({ task: t.id, spec: f, target })),
    );
}

/** Parked files still to keep in place in the repo (merged ones are gone for good). */
export const liveFiles = (s: SpecTask) => s.files.filter((f) => !s.merged?.[f]);

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

const TEST_DIR = /^(tests?|__tests__|specs?)$/i;
const LANG_DIR = /^(java|kotlin|scala|groovy|resources)$/;

/**
 * Folders where the project keeps its tests, from the tracked test files: e.g. "src/test/java/",
 * "order-service/src/test/java/", "tests/". Empty when tests live next to the code (Go, co-located JS)
 * or when there are no tests yet.
 */
export function testRoots(cwd: string): string[] {
  let tracked: string[];
  try {
    tracked = execFileSync("git", ["ls-files"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }).split("\n");
  } catch {
    return [];
  }
  const roots = new Set<string>();
  for (const f of tracked.filter((p) => TEST_FILE.test(p))) {
    const segs = f.split("/");
    const i = segs.findIndex((s, k) => k < segs.length - 1 && TEST_DIR.test(s));
    if (i < 0) continue;
    const end = LANG_DIR.test(segs[i + 1] ?? "") && i + 1 < segs.length - 1 ? i + 2 : i + 1;
    roots.add(`${segs.slice(0, end).join("/")}/`);
  }
  return [...roots].sort();
}

/** Parked tests whose target path isn't under one of the project's test folders: the build wouldn't run them. */
export function misplacedTests(roots: string[], files: string[]): string[] {
  if (!roots.length) return [];
  return files.filter((f) => !roots.some((r) => f.startsWith(r)));
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
      for (const f of s.files)
        lines.push(
          `- file: \`${f}\`${s.merged?.[f] ? ` (merged into \`${s.merged[f]}\`)` : s.extends?.[f] ? ` (to be merged into \`${s.extends[f]}\` at the end of the build)` : ""}`,
        );
      for (const x of s.tests) lines.push(`- ${x}`);
    }
    lines.push("");
  }
  if (spec.gaps?.length) lines.push("## Gaps in the spec (the tester had to guess)", "", ...spec.gaps.map((g) => `- ${g}`), "");
  if (spec.assumptions?.length) lines.push("## Tester's assumptions", "", ...spec.assumptions.map((a) => `- ${a}`), "");
  return lines.join("\n");
}
