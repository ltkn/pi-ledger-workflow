# pi-ledger-workflow

**Scope → plan → build → review for the [Pi coding agent](https://pi.dev).**
You talk to Pi while scoping and planning; the build runs as a loop of
fresh-context manager and worker calls that coordinate only through a ledger on
disk, with your test suite as ground truth.

The method is adapted from **GVS5H** by Gao, Khosrowshahi, Khosrowshahi, Sun,
Lee, Tran and Lee ([arXiv:2608.26480](https://arxiv.org/abs/2608.26480)) —
see [Credits](#credits).

```
/wf:scope <feature>   investigate + explore approaches      main session · you discuss
/wf:plan [guidance]   decisions + plan + task ledger        main session · you approve
/wf:tests [T# | skip] acceptance tests from the spec        fresh context · you review
/wf:build [answer]    manager → worker → verify, repeated   fresh contexts · automatic
/wf:review [focus]    independent review of the diff        fresh context
/wf:status            where things stand
/wf:stats [all]       rounds, reliability, tokens/context per role; all = compare by model
/wf:models [preset]   which model plays which role: single, mixed, escalation
/wf:undo [round]      go back to before a build round (picked from a list)
/wf:help [topic]      what to do next, and how to handle edge cases
```

`wf` = workflow. The `name:verb` form mirrors Pi's own `/skill:name`, can't
collide with built-ins or other extensions' `/plan`, and typing `/wf` lists
all ten commands.

**Day-to-day guide:** [`workflow-help.md`](extensions/wf/workflow-help.md)
covers the normal path and what to do when a task keeps failing, the build
stalls, the plan turns out wrong, or review leaves minor findings. You rarely
need to open it: after every phase Pi shows a short **What now** block for
the result you got, and `/wf:help <topic>` posts any section into the session.

## Install

```bash
pi install git:github.com/ltkn/pi-ledger-workflow@v0.2.0   # from git
pi install npm:pi-ledger-workflow                                       # from npm
pi install -l …                                                         # project-only
```

Try it once without installing: `pi -e git:github.com/ltkn/pi-ledger-workflow`.

Add the ledger to your project's `.gitignore` unless you want to keep it:

```
.pi/wf/
```

## The flow

```
/wf:scope Add order cancellation to the Spring Boot API
   → Pi reads the code, writes context.md + options.md, lists open questions
you: "Only from PENDING. Publish OrderCancelled via DomainEventPublisher."
/wf:plan
   → decisions.md (what you just said), plan.md, tasks.json
you: "Merge T3 into T2."            → /wf:plan again (revises, keeps done tasks)
/wf:tests
   → a fresh tester writes acceptance tests from the plan alone (parked in .pi/wf/spec/)
     and lists the gaps it had to guess; you review them
/wf:build
   round 1  manager → T1 → worker → mvn test ✓
   round 2  manager → T2 → worker → mvn test ✗ → manager → fix → ✓
   …
   ✅ BUILD COMPLETE   (assumptions listed)
/wf:review
   → fresh reviewer vs objective/plan/decisions; follow-ups become R1, R2… tasks
/wf:build                            → addresses R-tasks
```

**Spec tests** close the gap where the worker who writes the code also writes
the tests that prove it. The tester never sees the implementation; its tests are
copied into the repo when their task starts and restored before every test run,
so implementers can't change them. Skippable per task or per feature, never
silently. See [`/wf:help spec-tests`](extensions/wf/workflow-help.md#spec-tests).

**The one rule that makes this work:** build workers never see your chat. They
see `.pi/wf/`. `/wf:plan` writes your decisions into `decisions.md`, and
anything you tell `/wf:build` is appended there too. If you decide something in
plain conversation mid-build, either pass it with `/wf:build <decision>` or ask
Pi to add it to `decisions.md`.

## Questions during /wf:build

Yes, the build can ask — but rarely, by design. The plan should settle
*intent* (behaviour, API, data model). What the plan can't foresee is what the
code turns out to contain ("there are two event publishers"), so build keeps a
narrow channel for that:

- A **worker** may stop with `needs_input` only when the choice changes
  behaviour/API/data model, can't be derived from the ledger or the code's
  conventions, and a wrong guess is costly to undo. Everything else it decides
  itself and records under **assumptions**, which are shown at the end of the
  build and handed to the reviewer.
- The **manager** may ask when the plan contradicts the code.
- The **harness** asks when a task has used `maxTaskAttempts` rounds, or the
  loop stalls.

When a question comes up it's posted in the session and you get an inline
prompt: answer it and the loop continues immediately; leave it empty and the
build pauses so you can discuss with Pi, then resume with
`/wf:build <answer>`. Either way the answer lands in `decisions.md`.

`/wf:build <text>` with no pending question is recorded as guidance, so you
can steer between runs. Set `"questions": "assume"` to run unattended: nothing
blocks, every judgement call becomes a reviewable assumption.

Press **Esc** during build or review to stop; `/wf:build` resumes.

## Ledger (`.pi/wf/`)

| File | Written by | Seen by |
|---|---|---|
| `objective.md` | `/wf:scope` | everyone |
| `context.md` | scope (main session) | workers |
| `options.md` | scope | you, plan |
| `decisions.md` | plan, your answers/guidance | everyone — binding |
| `plan.md` | plan | everyone |
| `tasks.json` | plan, then manager via harness | manager, status |
| `notes.md` | harness, from each worker's report — **rewritten**, not appended | manager, workers |
| `assumptions.md` | harness | reviewer, you |
| `log.md` | harness, per round | manager (last 4), you |
| `review.md` | `/wf:review` | you |
| `checkpoints.json` | harness, per round | `/wf:undo` |
| `events.jsonl` | harness: every fresh call and round, as data | `/wf:stats` |
| `spec/`, `spec.json` | `/wf:tests` (parked acceptance tests + index) | you, workers (their task's), manager, reviewer |
| `state.json`, `config.json` | harness | — |

Workers are told not to touch `.pi/wf/`; the harness owns every ledger write
during build so caps and formats hold.

**Checkpoints.** Before and after every round the harness snapshots the working
tree into git's object store (`refs/wf/checkpoints`, via a private index), so
your branch, commits and staging area are never touched. From the two snapshots
it gives the manager the round's real diff, flags a round that reverts other
tasks' work or deletes/skips/cuts existing tests (a flagged round can't complete
its task), and lets `/wf:undo` restore any earlier state. See
[`/wf:help checks`](extensions/wf/workflow-help.md#what-the-harness-checks-after-every-round).

## Configuration

`.pi/wf/config.json` is created on the first `/wf:scope` in a project.

| Key | Default | Meaning |
|---|---|---|
| `maxRounds` | 10 | manager→worker cycles per `/wf:build` run (circuit breaker, paper's MAX_ITERS) |
| `maxTaskAttempts` | 4 | rounds one task may take before you're asked |
| `verify` | `"auto"` | detects `./mvnw`/`mvn -B -q test`, gradle, npm, cargo, go, pytest; `null` disables; any shell string |
| `verifyTimeoutSec` | 900 | |
| `questions` | `"ask"` | or `"assume"` |
| `caps` | plan 0, notes 0, context 0, verifyOutput 20000 | max chars of each file fed into briefs; 0 = no cap. Only worth setting for a small-context model |
| `models` | `{}` | `{"manager": "…", "worker": "…", "reviewer": "…", "tester": "…"}` as `provider/model`; unset = your session's model. Easiest via `/wf:models` |
| `escalate` | null | `{"afterAttempts": 2, "model": "provider/model"}`: a task that failed that often moves to this model (set by `/wf:models mixed`) |
| `thinking` | `{}` | per role; unset = your session's level |
| `childExtensions` | false | load your other extensions in fresh workers |
| `workerTools` | read,bash,edit,write,grep,find,ls | |
| `specTests` | true | acceptance tests from the spec before the build (`/wf:tests`); only when a verify command exists |
| `checkpoints` | true | shadow snapshots around every round (git only): the manager gets the real diff, lost work and changed/skipped tests are flagged, `/wf:undo` works |

For a large Maven build, point `verify` at the affected module
(`"mvn -B -q -pl order-service -am test"`). Workers run targeted tests
themselves; the full verify is the gate.

## What's taken from the paper, and where it lives

| Paper (GVS5H) | pi-ledger-workflow |
|---|---|
| Fresh context per call, shared workspace on disk | every manager/worker/reviewer is a separate `pi --no-session` process; `.pi/wf/` is the workspace |
| Manager: plan + 3–6 seed tasks | `/wf:plan` — but in your session, so you shape it |
| Brainstorm worker: difficulty, approaches, pitfalls, no solution | `/wf:scope` → `options.md` |
| Manager: fold results into one task list, name the single next task | build loop manager (read-only tools), each round |
| Worker: do one task, rewrite notes as a curated whole | build worker; harness writes its notes block (optionally capped) |
| Verifier on public tests, verdict is ground truth, a fail vetoes "done" | your test command after every changed round; failing tests block completion and spawn a fix task |
| Manager can't finish on an empty workspace | "done" requires changes vs. the base commit, no open tasks, and a fresh passing verify |
| Guards: round budget, no-progress, cut-off summarizer, capped plan/notes | `maxRounds`; reissue-after-no-change stops; a reportless/cut-off worker is first resumed in its own session and asked for the report (read-only), then summarised by a fresh call if that fails; caps are off by default (modern context windows make truncation cost more than it saves) and available in `caps` |
| Finalizer | harness-written handoff message (no model call — the code is already on disk) |
| §4 proposal: fresh-perspective workers against anchoring | `/wf:review` deliberately gets objective/plan/decisions/diff but **not** worker notes |

Deliberate departures: the paper is fully autonomous on a benchmark, with its
tests given in advance; here `/wf:tests` writes them from your spec, you
approve them, and the harness keeps implementers from changing them; here scope
and plan are human checkpoints, questions have a narrow channel, and the
verifier is your real test suite instead of sample I/O. The paper also shows
the scaffold can hurt when deliberation talks itself out of a correct simple
approach — the review step and your plan approval are the counterweight.

## Using a local model (e.g. Qwen3.8-27B)

Smaller models are where the paper saw the largest gains (Qwen3.8-27B: 66.8% →
92.4% on its benchmark, the biggest jump of all models tested). The mechanisms it
identified — bounded calls, decomposition, reasoning committed to disk before it
runs away — are exactly the weaknesses of mid-size local models. But that
result is on single-file competitive programming with no tools; here workers
use tools in a real repository, and the baseline is Pi's own agent loop, not a
single call. Expect a real but smaller gain, and measure it on your own work.

Settings that matter for a local model:

- **Context.** Workers read files and test output on top of a ~7k-token brief.
  Give the model at least 64k context (`-c 65536` or more for `llama-server`);
  the 32k example in Pi's llama.cpp guide is too tight.
- **Cap each generation.** The paper's main failure for Qwen3.8-27B was reasoning
  that ran on until the token budget ended with no code emitted. A per-response
  cap on the server (`llama-server --n-predict 32768`) keeps each turn bounded; the
  ledger carries the work across rounds.
- **Thinking level per role.** Start with `"thinking": {"manager": "low",
  "worker": "medium", "reviewer": "high"}` and adjust.
- **Smaller tasks.** Ask `/wf:plan` for 5–8 small tasks rather than 3 large ones.
- **Mixed models.** `/wf:models mixed <strong> <local>` puts a stronger model
  on the tester, manager and reviewer and the local model on the worker, with
  escalation: a task that fails twice on the local model gets its next attempts
  on the strong one. Use a strong model for your main session (scope/plan) too.
  The paper used one model for every role, so this goes beyond its evidence;
  compare setups on your own work with `/wf:stats all`. See
  [`/wf:help models`](extensions/wf/workflow-help.md#choosing-models).
- **Context window warnings.** wf warns when a call uses over 80% of its
  model's window, and `/wf:stats` shows each role's peak as a share of it.
- Workers that end without their report are resumed in their own session and
  asked for it (with their full context, read-only); only if that fails does a
  fresh summarizer salvage the attempt. `/wf:stats` shows how often each
  happens ("resumed", "salvaged").

## Cost

Each round is two model calls (manager + worker) plus the test run; the paper
measured roughly 3× the tokens of a single call. Cost per run and per feature
is shown at the end of each build and in `/wf:status`, as reported by the
provider (zero for local models). `/wf:stats` breaks tokens, peak context, cost
and time down per role, and `/wf:stats all` compares features by model.

## Development

```bash
npm install
npm run check        # typecheck + end-to-end tests with a mock pi (no model needed)
pi -e ./             # run Pi with this working copy loaded
```

Set `PI_WF_PI_COMMAND` to override the `pi` executable used for fresh-context
calls (the tests use it to substitute `test/mock-pi.mjs`).

## Credits

The orchestration method — fresh-context manager and worker instances of one
model coordinating through a shared, capped on-disk ledger; a verifier whose
verdict overrides the manager; round budget, no-progress guard and cut-off
summarizer — comes from:

> Victor Gao, Vida Khosrowshahi, Ali Khosrowshahi, Xihao Sun, Juhyun Lee,
> Ethan Tran, Simon (Sang Won) Lee. **GVS5H: Zero-Shot Self-Orchestration with
> Ledger-Based Control Improves Coding in Language Models.** arXiv:2608.26480,
> 2026. https://arxiv.org/abs/2608.26480 · code: https://github.com/slee-persis/GVS5H

```bibtex
@article{gao2026gvs5h,
  title   = {GVS5H: Zero-Shot Self-Orchestration with Ledger-Based Control Improves Coding in Language Models},
  author  = {Gao, Victor and Khosrowshahi, Vida and Khosrowshahi, Ali and Sun, Xihao and Lee, Juhyun and Tran, Ethan and Lee, Simon (Sang Won)},
  journal = {arXiv preprint arXiv:2608.26480},
  year    = {2026}
}
```

This package is an independent adaptation for interactive coding in Pi and is
not affiliated with or endorsed by the authors. It contains no code from their
repository. Where it departs from the paper (human checkpoints, build-time
questions, a real test suite as verifier, tool-using workers) the results
reported in the paper do not directly apply.

Built on [Pi](https://pi.dev) by Earendil.

## License

MIT
