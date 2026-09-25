# Changelog

## Unreleased

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
