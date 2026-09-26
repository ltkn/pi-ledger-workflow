/**
 * What the agent is told in each phase. Planning and building happen in your Pi
 * sessions; only the review is a separate, fresh call.
 */
import { type ParsedSpec, REQUIRED_SECTIONS, type SpecTask } from "./spec.ts";
import { PB_DIR } from "./store.ts";

const P = PB_DIR.replace(/\\/g, "/");

/** The quality bar, shared by every phase that designs, writes or judges code. */
export const QUALITY_BAR = `We always favour the best-practice solution: clean, elegant, maintainable and secure, using current APIs and idioms of the stack. No quick fixes, workarounds or temporary hacks.`;
export const QUICK_FIXES = `silencing or swallowing errors, hardcoding values, special-casing the test's inputs, adding sleeps for timing, casting types away or disabling checks, copy-pasting code`;
/** How code comments are written, in any language (Javadoc, TSDoc/JSDoc, docstrings, SQL, config). */
export const COMMENT_RULES = `Comments (any language: Javadoc, TSDoc/JSDoc, docstrings, SQL, config): brief, and only where they tell the reader something the code can't: why, intent, constraints, non-obvious behaviour, units, invariants. Don't restate what the code does; a clear name beats a comment. Write for someone reading the current code: no history ("changed from X", "now uses Y", "fixed bug"), no task ids, no mention of this workflow. When your change makes a comment wrong, update or delete it. API docs state the contract (what it does, parameters, return value, errors) in a sentence or two, not the implementation. Match the comment density of the surrounding code.`;

/* ================================== plan ================================== */

export function planPrompt(feature: string, testCmd: string | null): string {
  return `[pb:plan] ${feature}

We are PLANNING this feature together. Editing and writing files is switched off in this phase: investigate with read-only tools, think, and discuss with me. No code changes.

1. Investigate the codebase: the files, classes and modules involved and the role each plays; the closest existing feature and how it is built; the conventions to follow; the test setup and the exact command to run one test class.
2. ${testCmd ? `Test baseline: run \`${testCmd}\` once (or the affected module's tests if it is very slow) and tell me whether it passes, how long it takes, and any failures that exist before this feature.` : "No test command is configured or detected: find the command that runs this project's tests, run it once, and tell me whether it passes."}
3. Then reply with what you found, what makes this feature hard, the approaches worth considering (with trade-offs and pitfalls), your recommendation and the questions only I can answer. Recommend the best-practice approach for this stack today, not the quickest to write. ${QUALITY_BAR} If the codebase's existing pattern is outdated or insecure, say so and let me decide.

When the discussion covers more than one shippable outcome, say so: each becomes its own spec.

We'll iterate. When I'm ready I'll run /pb:spec and you'll write the spec.`;
}

/* ================================== spec ================================== */

export function specPrompt(which: string, existing: string[]): string {
  return `[pb:spec]${which ? ` ${which}` : ""}

Write the final spec${which ? ` for: ${which}` : "(s)"} from our discussion by calling the pb_write_spec tool, one call per spec. A fresh build session will implement it from the spec ALONE: it will never see this conversation. What isn't in the spec doesn't exist for the build.

Before writing: if the discussion covers more than one shippable outcome (something you would merge as one pull request), or would need more than about 8–10 tasks, tell me it is really several features and propose how to split them, then write one spec each. Several small related changes can share one spec.

Each spec, in exactly this shape:

# <title>
Depends on: <name of another spec that must be built first> | none
Verification: tests | build | none — <why, unless tests>
New tests: yes | no — <why, if no>

## Goal
## Out of scope
## Decisions
Every decision I made, and every alternative we rejected, written as "Not doing X, because …" so it isn't reintroduced.
## Context
Facts with paths: the files, classes and modules involved and their roles, conventions to follow, the test setup and baseline. Everything a builder who never saw this conversation needs.
## Acceptance criteria
Checkable bullets.
## Tasks
### T1: <title>
What to change, where, and which pattern to follow; written for someone who never saw this conversation.
- Acceptance: <checkable>
- Test: \`<command that runs this task's tests>\`   (when Verification is tests)

Rules:
- Verification: "tests" runs the tests after each task, "build" only compiles or typechecks, "none" checks nothing. Use what we agreed; default to tests.
- New tests: "no" only if I said so. When it is yes, tests belong to the task that introduces the behaviour.
- Tasks in dependency order; each leaves the project compiling and the tests passing. As many as the feature needs; prefer small ones.
- The approach: ${QUALITY_BAR} Nothing is planned as a stopgap; what must wait goes under "Out of scope".
- Name: short kebab-case (e.g. "order-cancellation").${existing.length ? ` Existing specs: ${existing.join(", ")}. Reusing a name rewrites that spec.` : ""}
- Sections required: ${REQUIRED_SECTIONS.map((s) => `"## ${s}"`).join(", ")}. The tool rejects a spec that doesn't parse; fix it and call again.

Then tell me where each spec is, and anything still open.`;
}

/* ================================== build ================================== */

const BUILD_RULES = `Rules for this build:
- The spec is the source of truth. Decisions in it are binding; when I decide something new in this session, record it with pb_record_decision.
- ${QUALITY_BAR} Write what a senior engineer would approve in review. Never make something pass by ${QUICK_FIXES}: fix the root cause. If the proper fix needs something outside the task, finish with status "blocked" and say why.
- Follow the codebase's conventions. If one is outdated or insecure, stay consistent within the task and say so in your summary; don't rewrite beyond the task. Don't add dependencies or change versions unless the spec says so.
- Keep each change scoped to its task: no unrelated refactors, renames or reformatting. Leave no debug output, commented-out code or stray TODOs.
- ${COMMENT_RULES}
- Never delete, skip, disable or weaken a test to make a check pass. If a test is wrong, finish with status "blocked" and say why.
- Never run git commands that discard or move changes (checkout or restore of files, reset, stash, clean), and don't commit: the working tree holds this build's uncommitted work.
- Don't edit anything under ${P}/: the harness owns it.`;

function testsRule(spec: ParsedSpec): string {
  if (!spec.newTests) return `- New tests: NO for this feature (${spec.newTestsReason}). Don't add or extend tests; the existing ones must keep passing.`;
  return "- New tests: each task adds or extends the tests for the behaviour it introduces, in the project's existing test style.";
}

function gateLine(spec: ParsedSpec, testCmd: string | null, buildCmd: string | null): string {
  if (spec.gate === "tests") return `After each task the harness runs its test command (or \`${testCmd ?? "the test suite"}\`), and the full suite after the last task. A task is done only when that passes.`;
  if (spec.gate === "build") return `After each task the harness only compiles${buildCmd ? ` (\`${buildCmd}\`)` : ""} (${spec.gateReason}). A task is done only when that passes.`;
  return `The harness runs no checks for this feature (${spec.gateReason}): your own verification is all there is.`;
}

/** The first message of the build session: the spec, the rules, and the gap check before any code. */
export function buildSeed(name: string, markdown: string, spec: ParsedSpec, testCmd: string | null, buildCmd: string | null): string {
  return `[pb:build ${name}] You are building this feature in a fresh session, from the spec below and nothing else.

${BUILD_RULES}
${testsRule(spec)}
- ${gateLine(spec, testCmd, buildCmd)}

The harness hands you the tasks one at a time. Finish each with the pb_task_done tool; it is how the harness knows you are done.

FIRST, before writing any code: read the spec, then read the code it points to. Look for gaps, contradictions, or places where the spec doesn't match the code as it is now. Then call pb_spec_gaps with what you found (an empty list if nothing). Don't start on T1 yet.

--- spec: ${P}/specs/${name}/spec.md ---

${markdown}`;
}

export function taskPrompt(task: SpecTask, attempt: number, max: number): string {
  return `[pb:build] Task ${task.id}${attempt > 1 ? ` (attempt ${attempt} of ${max})` : ""}. Do only this task:

${task.text}

When it is complete and you have checked it, call pb_task_done with task "${task.id}" and status "done". If you can't finish it properly, status "blocked" and why; if you need my decision, status "question" and the question.`;
}

export function fixPrompt(taskId: string, what: string, output: string, attempt: number, max: number): string {
  return `[pb:build] ${taskId === "final" ? "The final check after the last task" : `The check for ${taskId}`} failed (attempt ${attempt} of ${max}): ${what}

${output}

Fix the root cause (not the symptom), then call pb_task_done again with task "${taskId}".`;
}
