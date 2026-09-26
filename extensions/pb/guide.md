# Using pb

(Placeholder: the full guide comes with the review and stats commit.)

<!-- pb:tip build.paused -->
**What now**
- Answer or discuss here, then `/pb:build` to continue (add guidance: `/pb:build <what to do>`; it's recorded in the spec's Decisions).
- Code went wrong? `/pb:undo` · spec wrong? fix it in your planning session with `/pb:spec {spec}`.
<!-- /pb -->

<!-- pb:tip build.paused-attempts -->
**What now** ({task} keeps failing its check)
- Look at the failure above. `/pb:build <hint or different approach>` gives {task} a fresh set of attempts.
- Code went somewhere bad? `/pb:undo {task}`, then `/pb:build <what to do differently>`.
<!-- /pb -->

<!-- pb:tip build.gaps -->
**What now**
- Answer the gaps here, in chat; the agent records your decisions in the spec.
- Then `/pb:build` starts T1. The spec itself is wrong? Fix it with `/pb:spec` in your planning session.
<!-- /pb -->

<!-- pb:tip build.done -->
**What now**
- Next: `/pb:review` (fresh eyes on the diff against the spec). Fix findings here, in this session.
- Then commit.
<!-- /pb -->

<!-- pb:tip undo.done -->
**What now**
- `/pb:build` continues from here. Changed your mind? `/pb:undo {id}` goes back.
<!-- /pb -->
