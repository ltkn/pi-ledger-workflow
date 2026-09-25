# Using wf, day to day

This is the practical guide: what a normal feature looks like, and what to do
when something doesn't go to plan. The [README](../../README.md) explains how
wf works; this file explains how to drive it.

You rarely need to open this file. After every scope, plan, build and review,
Pi shows a short **What now** block that fits the result you just got, and
`/wf:help <topic>` posts any section below into your session, so you can
discuss it with Pi right there. `/wf:help` on its own lists the topics.

<!-- wf:topic flow -->
## The normal path

A feature goes through five commands, and you only really work in the first three.

1. **`/wf:scope <feature>`**: Pi reads the code, writes down what it found
   (`context.md`) and the possible approaches (`options.md`), and asks you a
   few open questions. Answer them in plain chat. Push back if the
   recommendation is wrong. This is the cheapest moment to change your mind.
2. **`/wf:plan`**: Pi turns that conversation into `decisions.md`, `plan.md`
   and a task list. Read the tasks. If something's off, say so and run
   `/wf:plan` again; it revises and keeps anything already done.
3. **`/wf:tests`**: a fresh tester writes the acceptance tests from the plan
   alone, before any code exists. You read them: they're the spec in executable
   form, and the implementers won't be able to change them. See
   `/wf:help spec-tests`.
4. **`/wf:build`**: now it runs by itself. Each round a fresh manager picks
   one task, a fresh worker does it, and your test suite checks the result. You
   watch the widget, or go do something else.
5. **`/wf:review`**: a fresh reviewer who never saw the build's reasoning
   compares the diff against the objective, plan and decisions. If it passes,
   you commit.

The one thing to keep in mind all along: **build workers never see your
chat.** They only see `.pi/wf/`. Anything you decide has to land in
`decisions.md`. `/wf:plan` and `/wf:build <text>` do that for you; plain
conversation does not.
<!-- /wf -->

<!-- wf:topic spec-tests -->
## Spec tests

Normally the worker who writes the code also writes the tests that prove it
works: it grades its own homework. `/wf:tests` fixes that. After `/wf:plan`, a
fresh **tester** reads only the objective, decisions, plan and tasks, and writes
acceptance tests for each task, before any code exists.

- **They're parked, not in your code yet.** Files go to
  `.pi/wf/spec/<task>/<path in the repo>`, so tests for classes that don't exist
  yet can't break compilation. When a task starts, the build copies its tests
  into place; the worker makes them pass in the same round.
- **You review them first.** `/wf:tests` posts every test with what it checks,
  plus **gaps in the spec**: things the tester had to guess. Those gaps are gold:
  if a fresh reader can't write the tests from your plan, a worker can't build
  it right either. Read the files in `.pi/wf/spec/`, then:
  - change one task's tests: `/wf:tests T3 <what to change>`
  - fix a gap: say the decision, `/wf:plan` (the task changes, so its tests go
    stale), then `/wf:tests` rewrites only the stale ones.
- **Implementers can't change them.** Before every test run the build restores
  them from the parked copy. If a worker thinks one is wrong, it reports
  blocked, and the build asks you; only `/wf:tests` changes them.
- **They're new files only.** The tester never edits your existing tests;
  a file that would overwrite an existing one is dropped (you're told).
- **They go where your tests live.** The tester is told the project's test
  folders (e.g. `src/test/java/`), and `/wf:tests` warns about any file outside
  them: Maven, Gradle or pytest would never run it, and the gate would silently
  be missing.

**When tests don't fit**, skip them, but never silently:

- One task (config, a pure rename): the tester skips it itself and says why, or
  `/wf:tests skip T2 <why>`.
- The whole feature (a spike, a UI tweak, an urgent fix): `/wf:tests skip <why>`,
  or just run `/wf:build` and choose "build without" when it asks.
- Never: `"specTests": false` in `.pi/wf/config.json`.

Without spec tests the build works as before: workers write their own tests,
the checks still run, and the reviewer is told to look harder at whether the
tests really test the behaviour. Spec tests need a verify command; without
one they're off.

Tasks added later (review follow-ups, tasks the manager adds) have no spec
tests; `/wf:tests` adds them, and the build tells you which open tasks lack them.
<!-- /wf -->

<!-- wf:topic widget -->
## Watching a build

```
wf build — round 2/10 · worker T2   (Esc to stop)
- T1 [done] Add CHANGEPOINT_UNIVERSE allow-list constant (attempts: 1)
- T2 [doing] Enforce allow-list in the publisher + tests (attempts: 1)
- T3 [todo] Enrich GexKlComputer records + tests
  ↳ worker: edit src/main/java/…/RegimeMonitorDiscordPublisher.java
```

- **round 2/10**: rounds used in *this* `/wf:build` run. When it hits the
  budget, the build stops and `/wf:build` gives you another 10.
- **worker T2 / manager / verify**: who's working right now. `verify` is your
  test command.
- **attempts**: how many rounds this task has taken. At 4 (`maxTaskAttempts`)
  the build stops and asks you how to proceed.
- **`↳`**: the latest tool call, so you can see the worker isn't stuck.

A red test does **not** stop the build. The task stays `doing`, the next
manager sees the failing output and has to fix it or change approach, and the
build can't be declared done while tests fail. You only step in when the loop
stops.

**Esc** stops the build at any point. Nothing is lost: tasks, notes and the
code on disk stay as they are, and `/wf:build` picks up where it stopped.
<!-- /wf -->

<!-- wf:topic stopped -->
## When the build stops

The headline at the end of the build tells you what happened.

| Headline | What it means | What to do |
|---|---|---|
| ✅ BUILD COMPLETE | Every task done, tests pass | Read the listed assumptions, then `/wf:review` |
| ⏸ PAUSED, with a question | A worker or the manager needs a decision only you can make | `/wf:build <answer>`, or discuss here first |
| ⏸ PAUSED, task used its attempts | One task took `maxTaskAttempts` rounds | Find out why, then nudge, restructure or replan. See `/wf:help stuck-task` |
| ⏸ PAUSED, lost work | A round put earlier tasks' files back to how they were before the build (a stray `git checkout`/`stash`), and you didn't restore them | `/wf:undo` and pick that round, or keep it and `/wf:build <guidance>`. See `/wf:help checks` |
| ⏸ PAUSED, tests changed again | A worker deleted, skipped or cut down existing tests twice on the same task | Tell it what's allowed: `/wf:build <answer>`. See `/wf:help checks` |
| ⏹ STALLED | A task was handed out again after a round that changed nothing | Same as above: the worker is going in circles |
| ⏹ round budget reached | 10 rounds used, still work left | `/wf:build` to continue. Normal on bigger features |
| ⏹ STOPPED by you | You pressed Esc | `/wf:build` resumes |
| ⚠ BUILD ERROR | Something broke outside the model: provider error, verify timeout… | Check `.pi/wf/log.md`, fix the cause, `/wf:build` |

If a question pops up as an inline prompt during the build, answering there is
fastest: the loop continues right away. Leave it empty and the build pauses so
you can talk it over with Pi first.
<!-- /wf -->

<!-- wf:topic diagnose -->
## Find out why before you steer

Steering blind usually costs more rounds than it saves. Two minutes with these
usually tells you what's going on:

- **`/wf:status`**: task states, whether tests pass, any pending question.
- **`/wf:stats`**: rounds per task, salvaged reports, flags, and how full each
  role's context got.
- **`.pi/wf/log.md`**: one entry per round, with the manager's reasoning, the
  worker's summary, and the first line of the test result. Read the last few
  rounds of the stuck task and you'll usually see the pattern.
- **`.pi/wf/state.json`** → `lastVerify.summary`: the key failing lines from
  the test output.
- **`.pi/wf/notes.md`**: what the workers currently *believe* about the code.
  A wrong belief here ("the DTO lives in module X") explains a lot of loops,
  because every new worker inherits it.
- **`git diff`**: what the workers actually changed. They never commit.
- **`/wf:undo`** (then Esc): the list of rounds, each with its task, files
  changed, test result and any ⚑ flag. A quick way to see where it went wrong.

You can also just ask Pi in the main session: "why is T3 stuck? Look at
.pi/wf/log.md and the diff." It has the build messages in context and can
read the ledger.
<!-- /wf -->

<!-- wf:topic stuck-task -->
## A task keeps failing

Say T3 has used its attempts, or the build stalled on it. Look first
(`/wf:help diagnose`), then pick the smallest move that fixes the actual
problem:

- **A nudge**, when the worker is close but missing something:
  `/wf:build use the existing KlSnapshot record, don't add a new DTO`
- **A different approach**, when the approach itself is the problem:
  `/wf:build compute distancePct in the publisher instead`
- **Restructure**, when the task is too big or shouldn't exist:
  `/wf:build split T3 into T3a (records) and T3b (tests)` or
  `/wf:build drop T3`. The manager can add and drop tasks.

Whatever you pass to `/wf:build` goes into `decisions.md`, so it reaches every
later worker, not just the next one. If the build paused because T3 used its
attempts, your answer also resets T3's counter, so it gets a full set of rounds
again. Plain `/wf:build` without text asks you for the answer first.

When a nudge isn't enough:

- **The task itself is wrong** → `/wf:plan <what to change>`. See `/wf:help replan`.
- **The code went somewhere bad** → `/wf:undo` and pick the round before it
  went wrong. See `/wf:help undo`.
- **It's faster to do it yourself** → see `/wf:help fix-yourself`.
- **You don't need it** → set its `"status"` to `"dropped"` in
  `.pi/wf/tasks.json`, then `/wf:build`. The harness respects manual edits.

If one task regularly needs more than 4 rounds in your project, raise
`maxTaskAttempts` in `.pi/wf/config.json`, or ask `/wf:plan` for smaller tasks.
<!-- /wf -->

<!-- wf:topic replan -->
## The plan is wrong

Sometimes the build shows that a task doesn't make sense: the code isn't
shaped the way the plan assumed, or two tasks fight each other. Don't nudge
around it. Fix the plan:

1. Talk it through with Pi in the main session. It sees the build messages.
2. `/wf:plan <what to change>`, e.g. `/wf:plan merge T3 and T4, the records
   are built in the publisher`. Done tasks stay done; the rest is revised.
3. `/wf:build`.

Anything you decided in that conversation goes into `decisions.md` as part of
the replan, so the workers get it too.
<!-- /wf -->

<!-- wf:topic undo -->
## Throw away a bad attempt

wf snapshots the working tree before and after every build round, so undo is one
command:

```
/wf:undo
  ↺ before undo (12:41)
  r7  T3 partial · 3 files +12 −4 · verify ✗ · "moved distancePct into publisher"
  r6  T3 partial · 2 files +30 −2 · verify ✗ · "added KlSnapshot fields"
  r5  T2 done · 4 files +85 −10 · verify ✓ · …
  ⌂ start of build
```

Pick an entry and the working tree goes back to how it was **before** that
round: picking r6 drops rounds 6 and 7. You see the files and tasks that will
change and confirm first. The task list and `notes.md` go back too, so no one
works from notes about code that's gone. Then:

- Give a reason when asked (or `/wf:undo r6 <why>`). It goes into
  `decisions.md`, so the next worker doesn't walk the same way again.
- `/wf:build` continues from there.
- Changed your mind? `/wf:undo` again and pick **↺ before undo**.

Undo never touches your branch, your commits or your staging area; the
snapshots live in git's object store under `refs/wf/checkpoints` and are dropped
when you start the next feature.

**Git still works too, and commits are still a good habit.** When a build pauses
with T1 and T2 done, `git commit -am "T1-T2"` makes that state permanent. If you
undo past a commit, the undone work shows up as uncommitted changes against it
(you're warned). Review still sees the whole feature, because it diffs against
the commit the feature *started* from.
<!-- /wf -->

<!-- wf:topic checks -->
## What the harness checks after every round

Besides running your tests, wf compares the snapshots from before and after
each round, so it doesn't rely on the worker's word:

- **The real diff goes to the manager.** If the worker says "implemented X" and
  the diff says otherwise, the manager sees both and trusts the diff.
- **Lost work.** If a round puts files that *other* tasks changed back to how
  they were before the build (the usual trace of a stray `git checkout .` or
  `git stash`), you're asked right away whether to restore those files. Say yes
  and the build carries on; say no and it pauses, so you can `/wf:undo` or
  continue on purpose.
- **Changed tests.** If a round deletes an existing test file, cuts its number
  of test cases, or adds skip/disable markers, the task can't be marked done
  and the next manager and worker are told why. The second time on the same
  task, the build pauses and asks you, because sometimes a test change is
  legitimate, and only you can say so.

Both checks are heuristics, so they flag and never silently revert. Every flag
shows up with a ⚑ in the build summary, in `log.md` and in the `/wf:undo` list.
If you don't want any of this (say, a non-git project or a huge repo), set
`"checkpoints": false` in `.pi/wf/config.json`.
<!-- /wf -->

<!-- wf:topic fix-yourself -->
## Fix it yourself

Sometimes you, or Pi in the main session, can fix it faster than another round.
Edit the code, then hand control back:

```
/wf:build I fixed T3 in GexKlComputer.java, verify and continue
```

The next round sees your note, checks the task, and the tests run. If they
pass, T3 is marked done and the build moves on. If you'd rather skip the round
entirely, set T3's `"status"` to `"done"` in `.pi/wf/tasks.json` yourself.
<!-- /wf -->

<!-- wf:topic decisions -->
## You decided something in chat

Talking with Pi mid-build is fine, and often the right move. But a decision
you only make in chat is **invisible to the workers**. Before resuming,
get it on the ledger:

- `/wf:build <the decision>`: recorded as the answer to the pending question,
  or as guidance if there is none. This is the usual way.
- Or ask Pi: "add that to .pi/wf/decisions.md", then `/wf:build`.
- If the decision changes the plan itself, use `/wf:plan` instead. See
  `/wf:help replan`.
<!-- /wf -->

<!-- wf:topic findings -->
## After the review

**PASS with a few minor findings.** Just ask Pi in the main session: "fix
findings 1 and 3, then run the tests." It already has the review in context.
Don't use `/wf:build <guidance>` for this: every task is already done, so the
manager will most likely declare the build complete right away, without doing
your fixes. Afterwards, `/wf:review` again if you want a second independent
look. It diffs against the feature's starting commit, so it sees your fixes
too.

**Changes needed.** The reviewer turns its must-fix items into R-tasks (R1,
R2…) on the task list. `/wf:build` works through them. If you disagree with
one, say so and run `/wf:plan drop R2` (or set it to `"dropped"` in
`tasks.json`) before building.

**The fixes turn out bigger than expected.** Put them through the loop:
`/wf:plan add tasks for review findings 1 and 3`, then `/wf:build`. Existing
tasks stay done.

**Don't take "harmless" at face value.** A finding the reviewer waves through
can still matter to you. For example, a `.gitignore` that ignores all of `.pi/`
also hides `.pi/settings.json` and `.pi/extensions/`, which you want committed
if you install packages per project. `.pi/wf/` is the right rule.

Then commit and open a PR as usual.
<!-- /wf -->

<!-- wf:topic next-feature -->
## Starting the next feature

`/wf:scope <next feature>` moves the current ledger to
`.pi/wf-archive/<timestamp>/` and starts clean. Your `config.json` stays. The
archive sits outside `.pi/wf/` so the next feature's workers never stumble on
old plans, and it ignores itself in git. Commit
the previous feature first: the new feature's review diffs against the commit
it starts from, so anything uncommitted would show up in it.
<!-- /wf -->

<!-- wf:topic unattended -->
## Running unattended

Set `"questions": "assume"` in `.pi/wf/config.json`. Nothing blocks on you
any more: every judgement call is made on the spot and recorded as an
assumption, shown at the end of the build and handed to the reviewer. Pausing
because a task used its attempts still happens, since that's a safety stop, not
a question. Pair it with a larger `maxRounds` for long runs.
<!-- /wf -->

<!-- wf:topic setup -->
## Setup gotchas

- **"No verify command detected"**: set `"verify"` in `.pi/wf/config.json`,
  e.g. `"mvn -B -q test"`. Without it nothing checks the workers' claims.
- **Slow test suite**: point `verify` at the affected module
  (`"mvn -B -q -pl order-service -am test"`). Workers run targeted tests
  themselves; verify is the final check.
- **Gitignore `.pi/wf/`, not `.pi/`**: the rest of `.pi/` holds project
  settings you want committed.
- **Start from a clean tree**: uncommitted changes from before `/wf:scope`
  end up in the review diff.
<!-- /wf -->

<!-- wf:topic models -->
## Choosing models

Every wf role is a separate call, so each can use a different model. The idea:
spend on judgment, save on volume.

| Role | What it decides | Strong model? |
|---|---|---|
| your main session | scope and plan: what gets built | yes, pick it in Pi as usual |
| tester | the spec tests, i.e. what "done" means | yes: its tests are the gate for everything after |
| reviewer | whether the result is right | yes: the last check before you |
| manager | what to do next, when to change approach | helps; its calls are short |
| worker | writes the code | this is where the volume is: a cheaper or local model |
| summarizer | rare fallback | follows the worker |

**`/wf:models`** shows the current setup and changes it:

- **single**: every role uses your session model (the default).
- **mixed**: you pick a strong model (tester, manager, reviewer) and a worker
  model. `/wf:models mixed anthropic/claude-sonnet-5 llama/qwen3.8-27b` does it
  in one line.
- One role: `/wf:models worker llama/qwen3.8-27b`, or `session` to reset it.

**Escalation.** With mixed, a task that has failed twice on the worker model
gets its next attempts on the strong model: the cheap model does the bulk, the
hard tasks get help. `/wf:models escalate <model> [after N]` sets it,
`/wf:models escalate off` turns it off. The build summary lists every
escalation, and `/wf:stats` shows how many escalated attempts finished their
task.

**Context windows.** wf knows each model's context window from Pi. When a call
uses more than 80% of it, the build warns you: quality drops before the hard
limit. Smaller tasks (`/wf:plan`), a model with a bigger window, or (for local
models) a bigger `-c` on the server help. `/wf:stats` shows each role's peak as
a share of its window.

Before every build, review and test run, wf checks that each configured model
exists in Pi and has credentials, so a typo stops you once instead of failing
every round. Thinking levels per role are set in `.pi/wf/config.json`
(`"thinking": {"worker": "medium"}`).

Which setup is best for *your* code is an empirical question: build a few
features each way and compare them with `/wf:stats all`.
<!-- /wf -->

<!-- wf:topic stats -->
## Is it working? `/wf:stats`

`/wf:stats` shows a card for the current feature:

- **Tasks and rounds**: how many rounds each finished task took, how many were
  done on the first try, and which task took the most.
- **Reliability**: worker reports that were missing. A worker that ends
  without its report is first **resumed** in its own session and asked for it
  (from its full context, without being able to change anything); only if that
  fails is it **salvaged** by a fresh summarizer, or **lost**. Also manager
  rounds that produced no usable decision. With a smaller model, these
  are the first numbers to watch.
- **Tests, flags and you**: rounds with failing tests, vetoed finishes, lost
  work, changed tests, undos, questions and stops.
- **Tokens and context per role**: calls, **peak context** (the largest prompt
  a single call sent, i.e. how full that model's context got), the average peak,
  prompt and output tokens, the share served from cache, cost, time and model.
  If a worker's peak gets close to your model's context window, ask `/wf:plan`
  for smaller tasks or give the model more context.

Only the fresh calls wf makes are counted; your own main session (scope, plan,
chat) isn't.

`/wf:stats all` puts every feature in one table, grouped by the worker model
(with the manager model on the group line and an average row), so you can
compare setups on your own work: rounds per task, first-try rate, salvaged
reports, flags, review verdict, worker peak context, tokens, cost and time.
Features built before stats existed aren't shown.
<!-- /wf -->

<!-- wf:topic rules -->
## Rules of thumb

- **`/wf:build <guidance>`** to nudge a running feature.
- **`/wf:plan <change>`** when a task or the plan is wrong.
- **`/wf:undo`** when the code is wrong.
- **The main session** for small fixes after the build is done.
- **`/wf:tests`** before building: read the gaps, they're where the plan is unclear.
- **Look before you steer**: `/wf:status`, `log.md`, `notes.md`, `git diff`.
- **Commit as tasks succeed**, so undo is always cheap.
- If you decided it in chat, **put it on the ledger**.
<!-- /wf -->

## What now? (the blocks shown in Pi)

These are the short blocks Pi shows after each result, collected here for
reference. Text in `{braces}` is filled in with the actual task, limit and so on.

### After /wf:scope
<!-- wf:tip scope.done -->
**What now**
- Answer the open questions here, in plain chat. Push back on the recommendation if it's wrong.
- Nothing is recorded yet: `/wf:plan` turns this conversation into `decisions.md`.
- Next: `/wf:plan` (or `/wf:plan <extra guidance>`) · more: `/wf:help flow`
<!-- /wf -->

### After /wf:plan
<!-- wf:tip plan.done -->
**What now**
- Check the tasks: small, in dependency order, tests inside the task that adds the behaviour.
- Want changes? Say them here, then `/wf:plan` again (done tasks are kept).
- Next: `/wf:tests` writes the acceptance tests for you to review, then `/wf:build` · more: `/wf:help spec-tests`
<!-- /wf -->

### After /wf:tests
<!-- wf:tip tests.done -->
**What now**
- Read the tests (in `.pi/wf/spec/`) and the gaps above: this is your last cheap chance to catch a wrong spec.
- Change one task's tests: `/wf:tests <task> <what to change>` · a gap means the plan is unclear: decide, `/wf:plan`, then `/wf:tests`.
- No tests for a task: `/wf:tests skip <task> <why>`.
- Next: `/wf:build` · more: `/wf:help spec-tests`
<!-- /wf -->

### Build asked for spec tests
<!-- wf:tip tests.missing -->
**What now**
- `/wf:tests` writes acceptance tests from the plan; you review them, then `/wf:build`.
- Building without them on purpose? `/wf:tests skip <why>`, then `/wf:build`.
- More: `/wf:help spec-tests`
<!-- /wf -->

### Build complete
<!-- wf:tip build.done -->
**What now**
- Read the assumptions above: each is a choice nobody asked you about.
- Optional: commit now. Review still diffs against the feature's starting commit.
- Next: `/wf:review` · more: `/wf:help findings`
<!-- /wf -->

### Build paused with a question
<!-- wf:tip build.paused-question -->
**What now**
- Answer: `/wf:build <answer>`. It goes into `decisions.md` for every later worker.
- Unsure? Discuss here first, then `/wf:build <decision>`.
- The question means the plan is off? `/wf:plan <change>`, then `/wf:build`.
- More: `/wf:help decisions`
<!-- /wf -->

### Build paused: a task used its attempts
<!-- wf:tip build.paused-attempts -->
**What now** ({task} used all {max} attempts)
- Look first: `/wf:status`, `.pi/wf/log.md`, `git diff` (`/wf:help diagnose`).
- Nudge: `/wf:build <hint or different approach>`. This resets {task}'s attempts.
- Restructure: `/wf:build drop {task}` · `/wf:build split {task} into …`
- Code went wrong: `/wf:undo` to the round before, then `/wf:build <what to do differently>`.
- Task itself wrong: `/wf:plan <change>` · more: `/wf:help stuck-task`
<!-- /wf -->

### Build paused: lost work
<!-- wf:tip build.paused-lost-work -->
**What now** (round {round} of {task} reverted earlier tasks' work)
- Drop the round: `/wf:undo r{round}`.
- Or keep it on purpose: `/wf:build <what the worker should do instead>`.
- More: `/wf:help checks`
<!-- /wf -->

### Build paused: tests changed again
<!-- wf:tip build.paused-tampering -->
**What now** ({task}'s worker changed existing tests twice)
- Tests right? `/wf:build the tests are right, fix the code`.
- A test change legitimately needed? Say which and why: `/wf:build <answer>`.
- Want the old tests back? `/wf:undo` to before the round · more: `/wf:help checks`
<!-- /wf -->

### Build stalled
<!-- wf:tip build.stalled -->
**What now**
- The worker is going in circles. Check `.pi/wf/log.md` and `notes.md`: a wrong belief in the notes is a common cause.
- Nudge: `/wf:build <guidance>` · task wrong: `/wf:plan <change>` · code wrong: `/wf:undo`, then `/wf:build <guidance>`.
- More: `/wf:help stuck-task`
<!-- /wf -->

### Round budget reached
<!-- wf:tip build.budget -->
**What now**
- Normal on bigger features: `/wf:build` runs another {rounds} rounds.
- One task eating the rounds? Give guidance first: `/wf:build <hint>`.
- Good moment to commit the finished tasks · more: `/wf:help stuck-task`
<!-- /wf -->

### Build stopped by you
<!-- wf:tip build.aborted -->
**What now**
- Nothing is lost: `/wf:build` resumes.
- Stopped because it was heading the wrong way? `/wf:undo` to before that round, then `/wf:build <what to do instead>`.
- More: `/wf:help undo`
<!-- /wf -->

### Build error
<!-- wf:tip build.error -->
**What now**
- Check the error above and `.pi/wf/log.md`. Usual causes: a provider error or a verify timeout (`verifyTimeoutSec`).
- Fix the cause, then `/wf:build` resumes.
<!-- /wf -->

### After /wf:undo
<!-- wf:tip undo.done -->
**What now**
- `/wf:build` continues from here; your reason (if any) is in `decisions.md`.
- Changed your mind? `/wf:undo {id}` goes back to where you just were.
- More: `/wf:help undo`
<!-- /wf -->

### Review added follow-up tasks
<!-- wf:tip review.followups -->
**What now**
- `/wf:build` works through {tasks}. Want spec tests for them first? `/wf:tests`.
- Disagree with one? Say so here, then `/wf:plan drop <id>` before building.
- More: `/wf:help findings`
<!-- /wf -->

### Review passed
<!-- wf:tip review.pass -->
**What now**
- Minor findings? Just ask Pi here ("fix findings 1 and 3, then run the tests"). Not `/wf:build`: every task is done, so the loop would just finish.
- Bigger than expected? `/wf:plan add tasks for findings …`, then `/wf:build`.
- Then commit / open a PR. `/wf:scope` for the next feature archives this ledger · more: `/wf:help findings`
<!-- /wf -->

### Review without a verdict
<!-- wf:tip review.other -->
**What now**
- Read the findings above; no follow-up tasks were added.
- Small fixes: ask Pi here · work for the loop: `/wf:plan add tasks for …`, then `/wf:build`.
- More: `/wf:help findings`
<!-- /wf -->
