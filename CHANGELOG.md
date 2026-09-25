# Changelog

## Unreleased

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
- Fix: answering an attempt-limit pause with `/wf:build <guidance>` now resets the task's attempts (it used to re-ask immediately); plain `/wf:build` prompts for the answer

## 0.1.0

- `/wf:scope`, `/wf:plan`, `/wf:build`, `/wf:review`, `/wf:status`
- Fresh-context manager/worker loop over an on-disk ledger (`.pi/wf/`), test suite as ground truth
- Build-time questions (`questions: "ask" | "assume"`), inline answers, `/wf:build <answer|guidance>`
- Guards: round budget, per-task attempt limit, no-progress stop, cut-off summarizer, capped plan/notes
- Independent review without worker notes; review follow-ups become R-tasks
