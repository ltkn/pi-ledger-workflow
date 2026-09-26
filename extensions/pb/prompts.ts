/**
 * What the agent is told in each phase. Planning and building happen in your Pi
 * sessions; only the review is a separate, fresh call.
 */
import { tip } from "./help.ts";
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

We are PLANNING this together. Investigate freely: read and search the code, run the build and the tests, curl an API, write and run one-off scripts or programs (Python, Java, anything) to check an assumption. But don't change the project's files yet: editing or writing inside the project is blocked until /pb:build, so put scratch files in a temporary directory outside it (e.g. mktemp -d), and don't modify the project through bash either. Think, then discuss with me.

1. Investigate the codebase: the files, classes and modules involved and the role each plays; the closest existing feature and how it is built; the conventions to follow; the test setup and the exact command to run one test class.
2. ${testCmd ? `Test baseline: run \`${testCmd}\` once (or the affected module's tests if it is very slow) and tell me whether it passes, how long it takes, and any failures that exist before this feature.` : "No test command is configured or detected: find the command that runs this project's tests, run it once, and tell me whether it passes."}
3. Then reply with what you found, what makes this feature hard, the approaches worth considering (with trade-offs and pitfalls), your recommendation and the questions only I can answer. Recommend the best-practice approach for this stack today, not the quickest to write. ${QUALITY_BAR} If the codebase's existing pattern is outdated or insecure, say so and let me decide.

When the discussion covers more than one shippable outcome, say so: each becomes its own spec.

We'll iterate. When I'm ready I'll run /pb:spec and you'll write the spec. End your first reply with this block, verbatim:

${tip("plan.next")}`;
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
- State each fact once. When the same thing appears in two forms (an example and the rule behind it, a mockup and a layout spec), the two will drift apart: keep one as the reference and say so.
- Sections required: ${REQUIRED_SECTIONS.map((s) => `"## ${s}"`).join(", ")}. The tool rejects a spec that doesn't parse; fix it and call again.

Before calling pb_write_spec, check the spec against itself and against the code you read: examples versus rules, acceptance criteria versus tasks, "unchanged" versus "extended" (e.g. a test that must stay unedited while a type it uses changes), every path, name and signature it relies on. Resolve each problem you find with the best solution (what a senior engineer would choose for correctness and maintainability, even when it is more work) and write the resolution into the spec. Tell me what you resolved, briefly; ask me only about choices that are mine to make (behaviour, API, data).

Then tell me where each spec is, and anything still open. End your reply with this block, verbatim:

${tip("spec.next")}`;
}

/* ================================== build ================================== */

const BUILD_RULES = `Rules for this build:
- The planning is done: the design, the decisions and the tasks in the spec are settled. Implement them as written; don't re-plan or reconsider them. If something really can't be built as written, finish the task with status "question" (or "blocked") and say why, instead of redesigning it.
- The spec is the source of truth. Decisions in it are binding; when I decide something new in this session, record it with pb_record_decision.
- When the spec is ambiguous, contradicts itself, or doesn't match the code, don't stop to ask: choose the best solution, the one a senior engineer would pick for correctness and maintainability, even when it is more work. Stay consistent with the acceptance criteria and the code as it is; explicit rules outrank examples. Record the choice with pb_record_decision (assumption: true) and continue. Stop with status "question" only when the choice changes behaviour, an API or data in a way that is costly to undo.
- ${QUALITY_BAR} Write what a senior engineer would approve in review. Never make something pass by ${QUICK_FIXES}: fix the root cause. If the proper fix needs something outside the task, finish with status "blocked" and say why.
- Follow the codebase's conventions. If one is outdated or insecure, stay consistent within the task and say so in your summary; don't rewrite beyond the task. Don't add dependencies or change versions unless the spec says so.
- Keep each change scoped to its task: no unrelated refactors, renames or reformatting. Leave no debug output, commented-out code or stray TODOs.
- ${COMMENT_RULES}
- Never delete, skip, disable or weaken a test to make a check pass. If a test is wrong, finish with status "blocked" and say why.
- Never run git commands that discard or move changes (checkout or restore of files, reset, stash, clean), and don't commit: the working tree holds this build's uncommitted work.
- Don't read or edit anything under .pi/ other than your spec: the harness owns it, and other files there (old plans, other tools' notes) are not part of this build.`;

function testsRule(spec: ParsedSpec): string {
  if (!spec.newTests) return `- New tests: NO for this feature (${spec.newTestsReason}). Don't add or extend tests; the existing ones must keep passing.`;
  return "- New tests: each task adds or extends the tests for the behaviour it introduces, in the project's existing test style.";
}

function gateLine(spec: ParsedSpec, testCmd: string | null, buildCmd: string | null): string {
  if (spec.gate === "tests") return `After each task the harness runs its test command (or \`${testCmd ?? "the test suite"}\`), and the full suite after the last task. A task is done only when that passes.`;
  if (spec.gate === "build") return `After each task the harness only compiles${buildCmd ? ` (\`${buildCmd}\`)` : ""} (${spec.gateReason}). A task is done only when that passes.`;
  return `The harness runs no checks for this feature (${spec.gateReason}): your own verification is all there is.`;
}

/** The first message of the build session: the rules and the spec; the first task follows it. */
export function buildSeed(name: string, markdown: string, spec: ParsedSpec, testCmd: string | null, buildCmd: string | null): string {
  return `[pb:build ${name}] You are building this feature in a fresh session, from the spec below and nothing else.

${BUILD_RULES}
${testsRule(spec)}
- ${gateLine(spec, testCmd, buildCmd)}

The harness hands you the tasks one at a time. Finish each with the pb_task_done tool; it is how the harness knows you are done.

Your first task follows the spec.

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

/* ================================== review ================================== */

export const REVIEWER_SYSTEM = `You are an independent REVIEWER in a fresh context. You did not take part in planning or building, and you are deliberately not shown the build conversation: judge the actual code against the spec.

Do not modify any file. Use read/grep/find/ls and bash only for inspection (git diff, git status, running a test is fine). Never run git commands that change the working tree or index (checkout, restore, reset, stash, clean, add, commit): the change under review may be uncommitted. Ignore .pi/ except the spec you are given.

The harness already ran this feature's check on the current tree; the result is in the brief. Don't re-run the full suite; run a specific test only when you need evidence. Read the diff file by file.

Check:
- The spec's acceptance criteria, one by one: met or not met, with evidence (file:line or test name). Each task's acceptance too.
- The spec's decisions respected, including the rejected alternatives ("Not doing X"): flag anything the build brought back.
- The builder's assumptions (Decisions entries starting "Assumption (build):"): the choices it made where the spec was ambiguous. Flag any that look wrong or second-best.
- Missing cases, error handling, convention breaks, changes outside the spec's scope, debug output, commented-out code or leftover TODOs.
- Tests, according to the spec's "New tests" line: when it is yes, tests that don't really test the behaviour, and missing tests for new behaviour; either way, existing tests that were deleted, skipped, disabled or weakened.
- Comments that restate the code, narrate history ("changed from", "now uses", task ids), mislead, or were left wrong by the change. The rule the build followed: ${COMMENT_RULES}
- The quality bar: ${QUALITY_BAR} Flag quick fixes and workarounds (${QUICK_FIXES}), outdated or deprecated APIs, and security problems (injection, secrets in code, missing validation or authorisation, unsafe defaults).

"changes_needed" is only for what should block a merge: an unmet acceptance criterion or decision, a bug, missing tests for new behaviour (unless the spec says no new tests), a weakened test, a risky change outside scope, a quick fix or workaround where a proper solution belongs, a security problem. Nits and pre-existing issues are findings, not blockers; if those are all you found, the verdict is "pass".

Write the review in markdown: verdict first, then the acceptance checklist, then findings numbered and ordered by severity, each with file:line and a concrete fix. Be brief on what is fine. End with exactly one line, the last of your reply: VERDICT: pass   or   VERDICT: changes_needed`;

export function reviewerBrief(o: { name: string; markdown: string; spec: ParsedSpec; base?: string; changed: string[]; stat: string; check: string; focus: string }): string {
  const lines = [
    `# Review: ${o.name}${o.focus ? ` — focus: ${o.focus}` : ""}`,
    "",
    "## How to see the change",
    "",
    o.base ? `Base commit: ${o.base}\nRun: git diff ${o.base} -- . ':(exclude).pi'   and read the untracked files listed below.` : "No base commit recorded: use git diff HEAD and git status.",
    "",
    "## Changed files",
    "",
    o.changed.join("\n") || "(none)",
    o.stat ? `\n${o.stat}` : "",
    "",
    "## The check the harness ran",
    "",
    o.spec.gate === "none" ? `None: verification is "none" for this feature (${o.spec.gateReason}). Look harder at correctness yourself.` : o.check,
    "",
    `## The spec (${P}/specs/${o.name}/spec.md)`,
    "",
    o.markdown,
  ];
  return lines.join("\n");
}
