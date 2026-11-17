# task MERGE {{batch}} - fast-forward {{main}} to the gated merge-queue batch ({{count}} branches; written by `norn mergeq`, META-GTP-MERGEQ)

You are the merge worker for merge-queue {{batch}} of project {{project}}. The check-in never merges; you do, on evidence.
{{suite}} the batch tip {{tip}} = {{main}} {{base_short}} + one `--no-ff` merge commit per branch below
(gate log {{gate_log}}). Main checkout {{main_checkout}} (the one writer of {{main}}: its worktree lock); batch worktree {{scratch}}.
Norn: {{norn}}. NOTES {{notes}} (durable, outside every worktree); last line exactly `## DONE`, `## STOPPED: <why>` or `## HANDOFF`. Then `{{norn}} done` with the same outcome (`--outcome stopped --why "<why>"` / `--outcome handoff`): the run's own result file.
STAGED: merge exactly that tested tip. NEVER touch a lane worktree (no fetch, rebase, merge, checkout, commit or push there).
Never force-push, never rewrite {{main}}, never loosen a test.

Branches (each its own merge commit = one revert command each):
{{members}}

1. `git -C {{main_checkout}} pull --ff-only origin {{main}}`; then `git -C {{main_checkout}} rev-parse {{main}}` must be {{base}}. Else
   `## STOPPED: {{main}} moved since the batch was gated` - nothing merged (`norn mergeq` rebuilds the batch on the new {{main}}).
2. {{shots}}
3. `git -C {{main_checkout}} merge --ff-only {{tip}}` (the gated tree itself: the suite already ran on it), then `{{norn}} smoke` in
   {{main_checkout}}. A red smoke = revert every merge commit above, newest first (`git -C {{main_checkout}} revert --no-edit -m 1 <merge>`
   each: NEW commits, never a reset or force), push, and `## STOPPED: smoke red after the merge, reverted`.
4. Green smoke: `git -C {{main_checkout}} push origin {{main}}`; restart the live dash (it serves the merged code):
   `{{norn}} dash restart` - nothing else (it stops only this install's recorded dashboard; an error = note it in NOTES, stop no other process).
5. Notify the owner (`{{norn}} notify --class merge --title "merged {{batch}}: {{count}} branches" --body "<tip>, {{suite_ran}} + smoke green; revert one: <the revert lines above>"`{{shot_flag}}).
   Write NOTES: the merged tip, the gate log, smoke result, shots paths, one revert command per branch; end `## DONE`.
