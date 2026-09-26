# Changelog

## Unreleased

- Optional (`"mergeSpecTests": true`, off by default): spec tests merged at the end of the build: the tester records which existing test file each Spec file extends, and once every task is done, a last task (M1) moves those tests into it (following its grouping convention) and deletes the Spec file. The harness checks that no test case was lost before M1 counts as done; review sees the merged result
- Tester: when the plan changes existing tests, those edits stay with the workers and the acceptance checks go in a new sibling file named after the behaviour it pins (e.g. `OrderRenderTest` → `OrderRenderCompactHeaderSpecTest`), so later features don't collide with earlier Spec files; a dropped copy of an existing file now says why and where the test belongs instead
- `/wf:tests` tells the tester where the project keeps its tests (e.g. `src/test/java/`, detected from the tracked test files) and warns about any spec test placed outside those folders, which the build would never run
- Fix: finished features are archived to `.pi/wf-archive/` (which ignores itself in git) instead of `.pi/wf/archive/`, so fresh roles exploring the ledger no longer read old features' plans and spec tests; existing archives are moved automatically. Fresh roles are also told to ignore anything about other features
- Comment rules for workers and the tester, checked by the reviewer, in any language (Javadoc, TSDoc, docstrings, SQL, config): brief, only what the code can't say (why, intent, constraints, non-obvious behaviour); no restating the code, no history or task ids, wrong comments updated or removed; API docs state the contract in a sentence or two; match the surrounding density
- A shared quality bar in every role that designs, writes or judges code: best-practice, clean, secure solutions with current APIs, no quick fixes. Scope recommends accordingly (and flags outdated or insecure existing patterns for you to decide); the plan allows no stopgaps; workers fix root causes and never make things pass by silencing errors, hardcoding, special-casing test inputs, sleeps, type casts or copy-paste; the manager asks for root-cause fixes; the tester writes tests a hardcoded implementation can't pass; the reviewer flags quick fixes, deprecated APIs and security problems, and they block a merge
- No length caps by default: `context.md`, `plan.md` and `notes.md` reach every brief whole (they used to be cut at 6000/4000/8000 chars, silently). `caps` stays available for small-context models (0 = no cap); configs that still carry the old default caps are cleaned up automatically. Test output is summarized with more key lines (100) and tail (80), up to 20000 chars; the manager sees the whole recent log and up to 20000 chars of the round's diff
- No length hints in the prompts: `context.md` and `plan.md` have no limit (complete beats short); the core difficulty, approaches and the plan's approach take as much detail as they need; as many tasks as the feature needs; the manager checks facts with tools whenever needed and explains its reasoning; worker and summarizer summaries and notes have no length target (notes are still rewritten, not appended)
- `/wf:models`: shows which model plays which role and changes it: `single`, `mixed <strong> <worker> [after]` (strong model on tester, manager and reviewer, cheaper one on the worker), one role, or `escalate <model> [after] | off`; interactive picker from Pi's available models
- Escalation: a task that has failed `afterAttempts` times on the worker model gets its next attempts on a stronger model (on by default with `mixed`); listed in the build summary and counted in `/wf:stats`
- Models are validated against Pi's registry (known, with credentials) before every build, review and test run
- Context-window warnings when a call uses over 80% of its model's window; `/wf:stats` shows each role's peak as a share of its window
- A worker that ends without its report is resumed in its own session (kept in a temporary folder, always deleted after the round) and asked for the report, read-only, from its full context; the summarizer is now only the fallback. `/wf:stats` counts reports as ok / resumed / salvaged / lost
- `/wf:stats`: per-feature card with tasks and rounds (per done task, first-try rate), reliability (salvaged/lost reports, missing manager decisions), failing tests, vetoes, flags, undos, questions, review verdicts, spec coverage, and per role: calls, peak and average context, prompt/output tokens, cache share, cost, time and model. `/wf:stats all` compares every feature, grouped by worker model. Data comes from `.pi/wf/events.jsonl`, which the harness now writes
- Requires Node ≥ 22.19 (Pi's own minimum); dev tooling on TypeScript 7, `@types/node` 26, latest Pi; CI tests Node 22, 24 and 26
- Spec tests: `/wf:tests` runs a fresh tester that writes acceptance tests from the spec before the build, parked in `.pi/wf/spec/` so they can't break compilation; you review them along with the gaps it had to guess. A task's tests are copied into the repo when it starts and restored before every test run, so implementers can't change them. `/wf:tests T3 <change>` rewrites one task's tests; changed tasks go stale and are rewritten on the next `/wf:tests`
- Skipping is explicit: `/wf:tests skip [T2] <why>`, or "build without" when `/wf:build` asks; the reviewer is told. On by default when a verify command exists (`"specTests": false` turns it off); `models.tester` / `thinking.tester` pick the tester's model
- Checkpoints: shadow snapshots of the working tree before and after every build round, in git's object store (`refs/wf/checkpoints`); your branch, commits and staging area are never touched. Disable with `"checkpoints": false`
- The manager's brief shows what the last round actually changed (diff stat and capped patch), and it's told to trust the diff over the report
- Lost-work detection: a round that puts other tasks' files back to their start-of-build state is flagged; you're asked to restore those files, or the build pauses
- Test-tampering detection: deleted test files, fewer test cases or new skip markers in existing tests block the task from completing; the second time on the same task pauses the build
- `/wf:undo [round] [why]`: pick a round from a list and restore the working tree, task list and notes to before it; the reason goes into `decisions.md`; undo itself can be undone

## 0.2.0

- `workflow-help.md`: day-to-day guide for the normal path and edge cases (stuck tasks, stalls, replanning, undo, review findings)
- Situational **What now** block after every scope, plan, build and review result, taken from `workflow-help.md`
- `/wf:help [topic]` posts a guide section into the session
- Prompts hardened for smaller models:
  - output templates are valid JSON, with the field rules listed under them; the parser also repairs raw newlines inside strings
  - worker notes come in their own ```` ```wf-notes ```` markdown block instead of a JSON string
  - the manager sends only changed or new tasks; the harness keeps task order and the plan's details
  - workers must not discard working-tree changes with git or delete/skip/weaken tests (the reviewer checks for the latter)
  - the manager may drop a task only when it's unnecessary, never because it's hard; continuing a partial task is allowed, repeating an unchanged round is not ("files changed" is now in its brief)
  - explicit precedence when sources disagree: newest decision > manager instruction > task detail > plan
  - the cut-off summarizer always reports "partial" (it can't see tool results) and gets the task's acceptance
  - `/wf:plan` re-runs replace reversed decisions and keep task ids, status, attempts and source
- Prompts improved for smaller models:
  - worker: defined statuses, a stop rule (same error three times → report partial/blocked), read-before-edit steps, no debug leftovers, fixed notes headings, calibrated assumptions/proposals; its brief now names the verify command, the attempt number and the previous attempt at the same task
  - manager: structured `instruction`, escalation after 2 unsuccessful rounds, a tool budget, may ask when verification fails for unrelated reasons
  - reviewer: acceptance criteria checked one by one with evidence, calibrated `changes_needed`, no full re-run of the suite
  - scope records the test baseline (pass/fail, duration, pre-existing failures) and the targeted-test command; plan asks for smaller tasks with self-checkable acceptance
  - every fresh call ends with a role-specific instruction naming the block it must end with
- Fix: answering an attempt-limit pause with `/wf:build <guidance>` now resets the task's attempts (it used to re-ask immediately); plain `/wf:build` prompts for the answer

## 0.1.0

- `/wf:scope`, `/wf:plan`, `/wf:build`, `/wf:review`, `/wf:status`
- Fresh-context manager/worker loop over an on-disk ledger (`.pi/wf/`), test suite as ground truth
- Build-time questions (`questions: "ask" | "assume"`), inline answers, `/wf:build <answer|guidance>`
- Guards: round budget, per-task attempt limit, no-progress stop, cut-off summarizer, capped plan/notes
- Independent review without worker notes; review follow-ups become R-tasks
